import type { SignalMessage } from "@/lib/signaling";
import { FileChunker } from "./file-chunker";
import {
  createSignalingTransport,
  type SignalingTransport,
} from "./signaling-transport";
import { fetchIceServers } from "./ice";
import {
  isUsefulIceCandidate,
  prepareSessionDescription,
  summarizeCandidates,
} from "./sdp";

export type ConnectionState =
  | "idle"
  | "waiting"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closed";

export interface ReceivedFile {
  name: string;
  size: number;
  blob: Blob;
}

export interface TransferProgress {
  fileName: string;
  sent: number;
  total: number;
}

export interface TransferSessionOptions {
  roomId: string;
  role: "host" | "guest";
  onStatus: (status: ConnectionState) => void;
  onFileReceived: (file: ReceivedFile) => void;
  onFileSent?: (file: { name: string; size: number }) => void;
  onReceiveError?: (message: string) => void;
  onProgress: (progress: TransferProgress) => void;
  onTransferActive?: (active: boolean) => void;
  onDebug?: (message: string) => void;
}

interface FileMetaMessage {
  type: "meta";
  name: string;
  size: number;
  mimeType: string;
}

interface FileDoneMessage {
  type: "done";
}

interface PartitionMessage {
  type: "partition";
  offset: number;
}

interface PartitionReceivedMessage {
  type: "partition-received";
  offset: number;
}

type ControlMessage =
  | FileMetaMessage
  | FileDoneMessage
  | PartitionMessage
  | PartitionReceivedMessage;

const GUEST_READY_RETRY_MS = 1500;
const ICE_GATHER_TIMEOUT_MS = 8000;
const RECONNECT_DELAY_MS = 800;
const PROGRESS_UPDATE_INTERVAL = 1 * 1024 * 1024;
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
const BUFFERED_AMOUNT_LOW_THRESHOLD = 2 * 1024 * 1024;
const PARTITION_ACK_TIMEOUT_MS = 60_000;

function waitForIceGathering(
  peer: RTCPeerConnection,
  timeoutMs: number
): Promise<void> {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      peer.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timer);
      resolve();
    };

    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };

    peer.addEventListener("icegatheringstatechange", onChange);
    const timer = setTimeout(finish, timeoutMs);
  });
}

export function createTransferSession(options: TransferSessionOptions) {
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let signaling: SignalingTransport | null = null;
  let guestReadyTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  let destroyed = false;
  let offerCreated = false;
  let makingOffer = false;
  let remoteDescriptionSet = false;
  let reconnecting = false;
  let transferActive = false;
  let wasConnected = false;

  const pendingSignals: SignalMessage[] = [];
  const pendingIceCandidates: RTCIceCandidateInit[] = [];

  let receiveBuffer: ArrayBuffer[] = [];
  let receiveMeta: FileMetaMessage | null = null;
  let receiveBytes = 0;
  let lastProgressBytes = 0;
  let lanHost: string | null = null;
  let iceServers: RTCIceServer[] = [];

  // Send state
  let sendQueue: File[] = [];
  let currentSendFile: File | null = null;
  let chunker: FileChunker | null = null;
  let lastAckedOffset = 0;
  let partitionAckWaiter: ((offset: number) => void) | null = null;
  let pendingPartitionAckOffset: number | null = null;

  function debug(message: string): void {
    options.onDebug?.(message);
  }

  function setTransferActive(active: boolean): void {
    if (transferActive === active) return;
    transferActive = active;
    options.onTransferActive?.(active);
  }

  async function sendSignal(message: SignalMessage): Promise<boolean> {
    if (!signaling) return false;
    return signaling.send(message);
  }

  function waitForPartitionAck(expectedOffset: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for receiver ack at ${expectedOffset} bytes`
          )
        );
      }, PARTITION_ACK_TIMEOUT_MS);

      partitionAckWaiter = (offset) => {
        if (offset !== expectedOffset) return;
        cleanup();
        resolve();
      };

      const channel = dc;
      const onClose = () => {
        cleanup();
        reject(new Error("Data channel closed while waiting for partition ack"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        partitionAckWaiter = null;
        channel?.removeEventListener("close", onClose);
      };
      channel?.addEventListener("close", onClose);
    });
  }

  function waitForSendBuffer(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
      return Promise.resolve();
    }

    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
        channel.removeEventListener("error", onError);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Data channel closed while waiting to send"));
      };
      const onError = () => {
        cleanup();
        reject(new Error("Data channel error while waiting to send"));
      };
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose);
      channel.addEventListener("error", onError);
    });
  }

  async function sendBinaryChunk(chunk: ArrayBuffer): Promise<void> {
    if (!dc || dc.readyState !== "open") {
      throw new Error("Data channel is not open");
    }
    await waitForSendBuffer(dc);
    dc.send(chunk);
  }

  function trySendPartitionAck(offset: number): void {
    if (!receiveMeta) return;
    if (receiveBytes < offset) {
      pendingPartitionAckOffset = offset;
      return;
    }
    pendingPartitionAckOffset = null;
    sendSignalOnChannel({
      type: "partition-received",
      offset,
    });
  }

  function maybeFlushPendingPartitionAck(): void {
    if (
      pendingPartitionAckOffset !== null &&
      receiveBytes >= pendingPartitionAckOffset
    ) {
      trySendPartitionAck(pendingPartitionAckOffset);
    }
  }

  async function flushPendingIce(): Promise<void> {
    if (!pc || !remoteDescriptionSet) return;

    for (const candidate of pendingIceCandidates.splice(0)) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // Ignore stale candidates.
      }
    }
  }

  function resetPeerFlags(): void {
    offerCreated = false;
    makingOffer = false;
    remoteDescriptionSet = false;
    pendingIceCandidates.length = 0;
  }

  function closePeerConnection(): void {
    if (dc) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onmessage = null;
      dc.onerror = null;
      try {
        dc.close();
      } catch {
        // ignore
      }
    }
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.ondatachannel = null;
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    dc = null;
    pc = null;
  }

  function attachPeerHandlers(peer: RTCPeerConnection): void {
    peer.onicecandidate = (event) => {
      if (
        event.candidate?.candidate &&
        isUsefulIceCandidate(event.candidate.candidate)
      ) {
        void sendSignal({
          type: "ice",
          candidate: event.candidate.toJSON(),
        });
      }
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      debug(`connection: ${state ?? "?"}`);

      if (state === "connected") {
        wasConnected = true;
        reconnecting = false;
        options.onStatus("connected");
        void logCandidatePair();
      } else if (state === "connecting") {
        options.onStatus("connecting");
      } else if (state === "disconnected") {
        if (!destroyed && wasConnected) {
          options.onStatus("reconnecting");
          scheduleReconnect();
        }
      } else if (state === "failed") {
        if (!destroyed && options.role === "host" && (transferActive || wasConnected)) {
          options.onStatus("reconnecting");
          scheduleReconnect();
        } else if (!destroyed) {
          options.onStatus("failed");
        }
      } else if (state === "closed") {
        if (!destroyed && !reconnecting) {
          options.onStatus("closed");
        }
      }
    };

    peer.oniceconnectionstatechange = () => {
      debug(`ice: ${peer.iceConnectionState ?? "?"}`);
      if (peer.iceConnectionState === "failed" && !destroyed) {
        if (options.role === "host" && (transferActive || wasConnected)) {
          options.onStatus("reconnecting");
          scheduleReconnect();
        } else {
          options.onStatus("failed");
        }
      }
    };
  }

  function setupDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

    channel.onopen = () => {
      if (guestReadyTimer) {
        clearInterval(guestReadyTimer);
        guestReadyTimer = null;
      }
      reconnecting = false;
      debug("data channel open");
      options.onStatus("connected");
      void logCandidatePair();

      if (options.role === "host" && currentSendFile) {
        void resumeSendAfterReconnect();
      }
    };

    channel.onclose = () => {
      debug("data channel closed");
      if (
        !destroyed &&
        options.role === "host" &&
        (transferActive || currentSendFile)
      ) {
        scheduleReconnect();
      }
    };

    channel.onerror = (event) => {
      debug(`data channel error: ${String(event)}`);
    };

    channel.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data === "string") {
        handleControlMessage(JSON.parse(event.data) as ControlMessage);
        return;
      }

      if (!receiveMeta) return;

      try {
        const chunk = event.data as ArrayBuffer;
        receiveBuffer.push(chunk);
        receiveBytes += chunk.byteLength;
        maybeFlushPendingPartitionAck();

        const isDone = receiveBytes >= receiveMeta.size;
        if (isDone || receiveBytes - lastProgressBytes >= PROGRESS_UPDATE_INTERVAL) {
          lastProgressBytes = receiveBytes;
          options.onProgress({
            fileName: receiveMeta.name,
            sent: receiveBytes,
            total: receiveMeta.size,
          });
        }
      } catch {
        abortReceive(
          `Not enough memory to receive "${receiveMeta.name}". Try a smaller file or free up space on this device.`
        );
      }
    };
  }

  function handleControlMessage(parsed: ControlMessage): void {
    switch (parsed.type) {
      case "meta":
        resetReceiveState();
        receiveMeta = parsed;
        setTransferActive(true);
        debug(
          `recv meta: ${parsed.name} (${(parsed.size / 1024).toFixed(1)} KB)`
        );
        break;

      case "partition":
        trySendPartitionAck(parsed.offset);
        break;

      case "partition-received":
        partitionAckWaiter?.(parsed.offset);
        partitionAckWaiter = null;
        lastAckedOffset = parsed.offset;
        break;

      case "done":
        debug(
          `recv done: ${receiveMeta?.name ?? "?"} — got ${receiveBytes} / ${receiveMeta?.size ?? "?"} bytes`
        );
        finalizeReceivedFile();
        break;
    }
  }

  function sendSignalOnChannel(message: ControlMessage): void {
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(message));
  }

  async function handleSignal(message: SignalMessage): Promise<void> {
    if (destroyed) return;
    if (!pc) {
      pendingSignals.push(message);
      return;
    }

    switch (message.type) {
      case "guest-ready":
        if (options.role === "host") {
          debug("guest ready");
          await createHostOffer();
        }
        break;

      case "offer":
        if (options.role === "guest" && message.sdp) {
          if (wasConnected || dc?.readyState === "open") {
            closePeerConnection();
            resetPeerFlags();
            pc = createPeerConnection();
          }

          options.onStatus("connecting");
          debug("got offer");
          await pc.setRemoteDescription(
            prepareSessionDescription(message.sdp)
          );
          remoteDescriptionSet = true;
          await flushPendingIce();

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);
          await sendLocalDescription("answer");
          debug("answer sent");
        }
        break;

      case "answer":
        if (options.role === "host" && message.sdp) {
          debug("got answer");
          await pc.setRemoteDescription(
            prepareSessionDescription(message.sdp)
          );
          remoteDescriptionSet = true;
          await flushPendingIce();
        }
        break;

      case "ice":
        if (
          message.candidate?.candidate &&
          isUsefulIceCandidate(message.candidate.candidate)
        ) {
          if (!remoteDescriptionSet) {
            pendingIceCandidates.push(message.candidate);
            return;
          }
          try {
            await pc.addIceCandidate(message.candidate);
          } catch {
            // Ignore stale candidates.
          }
        }
        break;
    }
  }

  function createPeerConnection(): RTCPeerConnection {
    const peer = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      iceCandidatePoolSize: 4,
    });
    attachPeerHandlers(peer);

    if (options.role === "host") {
      dc = peer.createDataChannel("files", { ordered: true });
      setupDataChannel(dc);
    } else {
      peer.ondatachannel = (event) => {
        dc = event.channel;
        setupDataChannel(dc);
        debug("data channel received");
      };
    }

    return peer;
  }

  async function sendLocalDescription(
    type: "offer" | "answer"
  ): Promise<boolean> {
    const local = pc?.localDescription;
    if (!local?.sdp) return false;

    const injectLan = options.role === "host" && type === "offer";
    const prepared = prepareSessionDescription(local, { lanHost, injectLan });
    debug(`${type} ${summarizeCandidates(prepared.sdp ?? "")}`);

    return sendSignal({ type, sdp: prepared });
  }

  async function createHostOffer(): Promise<void> {
    if (!pc || destroyed || offerCreated || makingOffer) return;

    makingOffer = true;
    options.onStatus("connecting");
    debug("creating offer");

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);

      const sent = await sendLocalDescription("offer");
      if (sent) {
        offerCreated = true;
        debug("offer sent");
      }
    } finally {
      makingOffer = false;
    }
  }

  function scheduleReconnect(): void {
    if (destroyed || options.role !== "host" || reconnecting) return;
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnectAsHost();
    }, RECONNECT_DELAY_MS);
  }

  async function reconnectAsHost(): Promise<void> {
    if (destroyed || options.role !== "host" || reconnecting) return;

    reconnecting = true;
    options.onStatus("reconnecting");
    debug("reconnecting WebRTC");

    closePeerConnection();
    resetPeerFlags();

    pc = createPeerConnection();
    await processPendingSignals();

    try {
      await createHostOffer();
    } catch (error) {
      debug(`reconnect failed: ${String(error)}`);
      reconnecting = false;
      options.onStatus("failed");
    }
  }

  async function resumeSendAfterReconnect(): Promise<void> {
    if (!currentSendFile || !dc || dc.readyState !== "open") return;

    debug(`resuming send at ${lastAckedOffset} bytes`);
    try {
      await runSendFile(currentSendFile, lastAckedOffset);
    } catch (error) {
      debug(`resume send failed: ${String(error)}`);
    }
  }

  function resetReceiveState(): void {
    receiveBuffer = [];
    receiveMeta = null;
    receiveBytes = 0;
    lastProgressBytes = 0;
    pendingPartitionAckOffset = null;
  }

  function abortReceive(reason: string): void {
    debug(`receive error: ${reason}`);
    setTransferActive(false);
    options.onReceiveError?.(reason);
    resetReceiveState();
  }

  function finalizeReceivedFile(): void {
    if (!receiveMeta) return;

    try {
      const blob = new Blob(receiveBuffer, {
        type: receiveMeta.mimeType || "application/octet-stream",
      });

      options.onFileReceived({
        name: receiveMeta.name,
        size: receiveMeta.size,
        blob,
      });

      resetReceiveState();
      setTransferActive(false);
    } catch (error) {
      const isOom =
        error instanceof RangeError ||
        (error instanceof Error &&
          /out of memory|alloc|quota/i.test(error.message));
      abortReceive(
        isOom
          ? `Not enough memory to save "${receiveMeta.name}". Try a smaller file or free up space on this device.`
          : `Could not save "${receiveMeta.name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function runSendFile(file: File, startOffset = 0): Promise<void> {
    if (!dc || dc.readyState !== "open") {
      throw new Error("Data channel is not open");
    }

    currentSendFile = file;
    lastAckedOffset = startOffset;
    setTransferActive(true);

    const mbSize = (file.size / (1024 * 1024)).toFixed(1);
    debug(
      `send start: ${file.name} (${mbSize} MB)${startOffset ? ` from offset ${startOffset}` : ""}`
    );

    if (startOffset === 0) {
      const meta: FileMetaMessage = {
        type: "meta",
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      };
      dc.send(JSON.stringify(meta));
    }

    if (file.size === 0) {
      dc.send(JSON.stringify({ type: "done" } satisfies FileDoneMessage));
      options.onFileSent?.({ name: file.name, size: file.size });
      currentSendFile = null;
      chunker = null;
      setTransferActive(false);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const startPartition = (offset: number) => {
        chunker = new FileChunker(
          file,
          offset,
          async (chunk) => {
            await sendBinaryChunk(chunk);
          },
          (partitionOffset) => {
            if (!dc || dc.readyState !== "open") {
              fail(new Error("Data channel closed during send"));
              return;
            }

            dc.send(
              JSON.stringify({
                type: "partition",
                offset: partitionOffset,
              } satisfies PartitionMessage)
            );

            void waitForPartitionAck(partitionOffset)
              .then(() => {
                lastAckedOffset = partitionOffset;
                options.onProgress({
                  fileName: file.name,
                  sent: partitionOffset,
                  total: file.size,
                });
                if (chunker && !chunker.isFileEnd()) {
                  startPartition(partitionOffset);
                }
              })
              .catch(fail);
          },
          () => {
            if (!dc || dc.readyState !== "open") {
              fail(new Error("Data channel closed during send"));
              return;
            }
            dc.send(JSON.stringify({ type: "done" } satisfies FileDoneMessage));
            debug(`send done: ${file.name}`);
            options.onFileSent?.({ name: file.name, size: file.size });
            currentSendFile = null;
            chunker = null;
            setTransferActive(false);
            finish();
          },
          (error) => fail(error)
        );
        chunker.nextPartition();
      };

      startPartition(startOffset);
    });
  }

  async function sendFile(file: File, startOffset = 0): Promise<void> {
    await runSendFile(file, startOffset);
  }

  async function processPendingSignals(): Promise<void> {
    const queued = pendingSignals.splice(0);
    for (const message of queued) {
      await handleSignal(message);
    }
  }

  async function announceGuestReady(): Promise<void> {
    if (destroyed || options.role !== "guest") return;
    const ok = await sendSignal({ type: "guest-ready" });
    if (ok) debug("guest-ready sent");
  }

  function startGuestReadyRetries(): void {
    if (options.role !== "guest" || guestReadyTimer) return;

    void announceGuestReady();
    guestReadyTimer = setInterval(() => {
      if (destroyed || dc?.readyState === "open") {
        if (guestReadyTimer) {
          clearInterval(guestReadyTimer);
          guestReadyTimer = null;
        }
        return;
      }
      void announceGuestReady();
    }, GUEST_READY_RETRY_MS);
  }

  async function logCandidatePair(): Promise<void> {
    if (!pc) return;
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      const reports = new Map<string, RTCStats>();
      stats.forEach((r) => reports.set(r.id, r));

      type CandReport = RTCStats & {
        candidateType?: string;
        address?: string;
        port?: number;
      };
      type PairReport = RTCStats & {
        nominated?: boolean;
        state?: string;
        localCandidateId?: string;
        remoteCandidateId?: string;
        currentRoundTripTime?: number;
        availableOutgoingBitrate?: number;
      };

      let logged = false;
      stats.forEach((report) => {
        if (report.type !== "candidate-pair" || logged) return;
        const pair = report as PairReport;
        if (!pair.nominated && pair.state !== "succeeded") return;

        const local = reports.get(pair.localCandidateId ?? "") as CandReport | undefined;
        const remote = reports.get(pair.remoteCandidateId ?? "") as CandReport | undefined;

        debug(
          `ICE path: ${local?.candidateType ?? "?"} ↔ ${remote?.candidateType ?? "?"}`
        );
        if (local?.candidateType === "relay" || remote?.candidateType === "relay") {
          debug("⚠ TURN relay active — speeds will be limited");
        }
        logged = true;
      });

      if (!logged) debug("ICE path: no active candidate pair found");
    } catch {
      debug("could not read ICE stats");
    }
  }

  async function init(): Promise<void> {
    options.onStatus("waiting");
    if (destroyed) return;

    try {
      debug("loading ICE config");
      const [servers, config] = await Promise.all([
        fetchIceServers(),
        fetch("/api/config")
          .then((response) => response.json() as Promise<{ lanHost?: string }>)
          .catch(() => ({ lanHost: null })),
      ]);
      iceServers = servers;
      lanHost = config.lanHost ?? null;

      if (destroyed) return;

      if (typeof RTCPeerConnection === "undefined") {
        debug("WebRTC not available in this browser");
        options.onStatus("failed");
        return;
      }

      signaling = await createSignalingTransport({
        roomId: options.roomId,
        role: options.role,
        onMessage: (message) => {
          void handleSignal(message);
        },
        onDebug: debug,
      });

      pc = createPeerConnection();
      debug(`${options.role} ready (${signaling.mode})`);

      await processPendingSignals();

      if (options.role === "guest") {
        startGuestReadyRetries();
      }
    } catch (error) {
      debug(`init failed: ${String(error)}`);
      if (!destroyed) options.onStatus("failed");
    }
  }

  async function sendFiles(files: File[]): Promise<void> {
    sendQueue = [...files];
    while (sendQueue.length > 0) {
      const file = sendQueue.shift()!;
      await sendFile(file);
    }
  }

  function destroy(): void {
    destroyed = true;
    setTransferActive(false);

    if (guestReadyTimer) {
      clearInterval(guestReadyTimer);
      guestReadyTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    signaling?.destroy();
    signaling = null;
    closePeerConnection();
  }

  return {
    init,
    sendFiles,
    destroy,
  };
}
