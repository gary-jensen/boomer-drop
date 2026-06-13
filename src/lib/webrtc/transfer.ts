import type { SignalMessage } from "@/lib/signaling";
import {
  createSignalingTransport,
  type SignalingTransport,
} from "./signaling-transport";
import { fetchIceServers } from "./ice";
import { FileChunker } from "./file-chunker";
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

function extractPrivateHostIp(sdp: string): string | null {
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const parts = line.split(" ");
    const ip = parts[4];
    if (!ip || ip.includes(".local")) continue;
    if (
      /^10\./.test(ip) ||
      /^192\.168\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    ) {
      return ip;
    }
  }
  return null;
}

function hasTurnServer(servers: RTCIceServer[]): boolean {
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(
      (url) => typeof url === "string" && url.startsWith("turn")
    );
  });
}

const GUEST_READY_RETRY_MS = 1500;
const ICE_GATHER_TIMEOUT_MS = 8000;
const RECONNECT_DELAY_MS = 800;
const PROGRESS_UI_INTERVAL_MS = 500;
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;
const PARTITION_ACK_TIMEOUT_MS = 90_000;
const SEND_HEARTBEAT_MS = 10_000;
const RECV_NOTIFY_INTERVAL_MS = 250;

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

  let receiveTarget: Uint8Array | null = null;
  let receiveFallbackChunks: ArrayBuffer[] = [];
  let receiveMeta: FileMetaMessage | null = null;
  let receiveBytes = 0;
  let lastLoggedRecvPct = -1;
  let progressFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastProgressUiAt = 0;
  let pendingProgress: TransferProgress | null = null;
  let lanHost: string | null = null;
  let iceServers: RTCIceServer[] = [];

  // Send state
  let sendQueue: File[] = [];
  let currentSendFile: File | null = null;
  let lastAckedOffset = 0;
  let sendHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastSendActivityAt = 0;
  let abortSend: ((error: Error) => void) | null = null;
  let recvNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  let fileChunker: FileChunker | null = null;
  let partitionAckTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStatsBytesSent = 0;
  let lastStatsAt = 0;

  function debug(message: string): void {
    options.onDebug?.(message);
    if (typeof console !== "undefined") {
      console.log(`[BoomerDrop] ${message}`);
    }
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

  function failActiveSend(message: string): void {
    abortSend?.(new Error(message));
  }

  function clearPartitionAckTimer(): void {
    if (!partitionAckTimer) return;
    clearTimeout(partitionAckTimer);
    partitionAckTimer = null;
  }

  function stopFileChunker(): void {
    fileChunker = null;
    clearPartitionAckTimer();
  }

  function sendRawChunk(file: File, chunk: ArrayBuffer): void {
    if (!dc || dc.readyState !== "open") {
      throw new Error("Data channel is not open");
    }
    dc.send(chunk);
    sendBytesQueued += chunk.byteLength;
    lastAckedOffset = sendBytesQueued;
    lastSendActivityAt = Date.now();
    scheduleProgress(file.name, sendBytesQueued, file.size);
  }

  function onPartitionEnd(file: File, offset: number): void {
    if (!dc || dc.readyState !== "open") {
      failActiveSend("Data channel closed during send");
      return;
    }

    dc.send(JSON.stringify({ type: "partition", offset } satisfies PartitionMessage));
    debug(`send partition @ ${(offset / (1024 * 1024)).toFixed(1)} MB`);

    clearPartitionAckTimer();
    partitionAckTimer = setTimeout(() => {
      failActiveSend(
        `Timed out waiting for receiver at ${(offset / (1024 * 1024)).toFixed(1)} MB`
      );
    }, PARTITION_ACK_TIMEOUT_MS);
  }

  function onPartitionReceived(offset: number): void {
    clearPartitionAckTimer();
    if (!fileChunker) return;
    debug(`partition ack @ ${(offset / (1024 * 1024)).toFixed(1)} MB`);
    fileChunker.nextPartition();
  }

  let sendBytesQueued = 0;
  let lastLoggedSendPct = -1;

  function flushProgress(force = false): void {
    if (!pendingProgress) return;
    const now = Date.now();
    const done = pendingProgress.sent >= pendingProgress.total;
    if (!force && !done && now - lastProgressUiAt < PROGRESS_UI_INTERVAL_MS) {
      return;
    }
    lastProgressUiAt = now;
    options.onProgress(pendingProgress);
    if (done) pendingProgress = null;
  }

  function scheduleProgress(fileName: string, sent: number, total: number): void {
    pendingProgress = { fileName, sent, total };
    flushProgress(sent >= total);
    if (sent >= total || progressFlushTimer) return;
    progressFlushTimer = setTimeout(() => {
      progressFlushTimer = null;
      flushProgress(true);
    }, PROGRESS_UI_INTERVAL_MS);
  }

  function logTransferProgress(
    direction: "send" | "recv",
    bytes: number,
    total: number,
    lastLoggedPct: number
  ): number {
    const pct = Math.min(100, Math.floor((bytes / total) * 100));
    const step = total >= LARGE_FILE_THRESHOLD ? 5 : 1;
    if (pct < lastLoggedPct + step && bytes < total) return lastLoggedPct;
    debug(
      `${direction} ${pct}% (${(bytes / (1024 * 1024)).toFixed(1)} MB)`
    );
    return pct;
  }

  function scheduleReceiveNotify(): void {
    if (recvNotifyTimer) return;
    recvNotifyTimer = setTimeout(() => {
      recvNotifyTimer = null;
      if (!receiveMeta) return;

      scheduleProgress(receiveMeta.name, receiveBytes, receiveMeta.size);
      lastLoggedRecvPct = logTransferProgress(
        "recv",
        receiveBytes,
        receiveMeta.size,
        lastLoggedRecvPct
      );
    }, RECV_NOTIFY_INTERVAL_MS);
  }

  function clearReceiveNotify(): void {
    if (!recvNotifyTimer) return;
    clearTimeout(recvNotifyTimer);
    recvNotifyTimer = null;
  }

  async function logTransferStats(file: File): Promise<void> {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      type PairReport = RTCStats & {
        nominated?: boolean;
        state?: string;
        bytesSent?: number;
        bytesReceived?: number;
        currentRoundTripTime?: number;
        availableOutgoingBitrate?: number;
      };

      let pairReport: PairReport | undefined;
      stats.forEach((report) => {
        if (report.type !== "candidate-pair") return;
        const pair = report as PairReport;
        if (pair.nominated || pair.state === "succeeded") {
          pairReport = pair;
        }
      });

      const now = Date.now();
      const parts: string[] = [];
      const bytesSent = pairReport?.bytesSent;

      if (bytesSent !== undefined && lastStatsAt > 0) {
        const dt = (now - lastStatsAt) / 1000;
        const ds = bytesSent - lastStatsBytesSent;
        if (dt > 0 && ds > 0) {
          parts.push(`link ${(ds / dt / 1024).toFixed(0)} KB/s`);
        }
        lastStatsBytesSent = bytesSent;
        lastStatsAt = now;
      } else if (bytesSent !== undefined) {
        lastStatsBytesSent = bytesSent;
        lastStatsAt = now;
      }

      if (dc && dc.bufferedAmount > 0) {
        parts.push(`buffer ${(dc.bufferedAmount / 1024).toFixed(0)} KB`);
      }

      if (parts.length > 0) {
        debug(`send stats: ${parts.join(", ")}`);
      }
    } catch {
      // ignore stats errors
    }
  }

  function startSendHeartbeat(file: File): void {
    stopSendHeartbeat();
    lastSendActivityAt = Date.now();
    lastStatsAt = Date.now();
    lastStatsBytesSent = 0;
    sendHeartbeatTimer = setInterval(() => {
      if (!currentSendFile) return;
      void logTransferStats(file);
      const idleMs = Date.now() - lastSendActivityAt;
      if (idleMs < SEND_HEARTBEAT_MS) return;
      const pct = ((sendBytesQueued / file.size) * 100).toFixed(1);
      debug(
        `send still running: ${pct}% (${(sendBytesQueued / (1024 * 1024)).toFixed(1)} MB), idle ${Math.round(idleMs / 1000)}s`
      );
    }, SEND_HEARTBEAT_MS);
  }

  function stopSendHeartbeat(): void {
    if (!sendHeartbeatTimer) return;
    clearInterval(sendHeartbeatTimer);
    sendHeartbeatTimer = null;
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
        debug("connection temporarily disconnected");
        if (!destroyed && transferActive) {
          options.onStatus("reconnecting");
          if (currentSendFile && options.role === "guest") {
            failActiveSend("Connection lost during send");
          }
        }
      } else if (state === "failed") {
        if (currentSendFile && options.role === "guest") {
          failActiveSend("Connection failed during send");
        }
        if (!destroyed && options.role === "host" && (transferActive || wasConnected)) {
          options.onStatus("reconnecting");
          scheduleReconnect();
        } else if (!destroyed) {
          options.onStatus("failed");
        }
      } else if (state === "closed") {
        if (currentSendFile) {
          failActiveSend("Connection closed during send");
        }
        if (!destroyed && !reconnecting) {
          options.onStatus("closed");
        }
      }
    };

    peer.oniceconnectionstatechange = () => {
      debug(`ice: ${peer.iceConnectionState ?? "?"}`);
      if (peer.iceConnectionState === "failed" && !destroyed) {
        if (currentSendFile && options.role === "guest") {
          failActiveSend("ICE connection failed during send");
        }
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
      if (currentSendFile) {
        failActiveSend("Data channel closed during send");
      }
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
        if (receiveTarget) {
          receiveTarget.set(new Uint8Array(chunk), receiveBytes);
        } else {
          receiveFallbackChunks.push(chunk);
        }
        receiveBytes += chunk.byteLength;
        scheduleReceiveNotify();
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
        try {
          receiveTarget = new Uint8Array(parsed.size);
        } catch {
          receiveTarget = null;
          receiveFallbackChunks = [];
          debug(
            `recv meta: ${parsed.name} (${(parsed.size / 1024).toFixed(1)} KB) — streaming chunks (low memory)`
          );
        }
        if (receiveTarget) {
          debug(
            `recv meta: ${parsed.name} (${(parsed.size / 1024).toFixed(1)} KB)`
          );
        }
        break;

      case "done":
        clearReceiveNotify();
        scheduleProgress(
          receiveMeta?.name ?? "?",
          receiveBytes,
          receiveMeta?.size ?? receiveBytes
        );
        debug(
          `recv done: ${receiveMeta?.name ?? "?"} — got ${receiveBytes} / ${receiveMeta?.size ?? "?"} bytes`
        );
        finalizeReceivedFile();
        break;

      case "partition":
        if (dc?.readyState === "open") {
          dc.send(
            JSON.stringify({
              type: "partition-received",
              offset: parsed.offset,
            } satisfies PartitionReceivedMessage)
          );
        }
        break;

      case "partition-received":
        onPartitionReceived(parsed.offset);
        break;
    }
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

      const detectedLan = extractPrivateHostIp(pc.localDescription?.sdp ?? "");
      if (detectedLan) {
        lanHost = lanHost ?? detectedLan;
        debug(`LAN IP for ICE: ${detectedLan}`);
      }

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
    clearReceiveNotify();
    receiveTarget = null;
    receiveFallbackChunks = [];
    receiveMeta = null;
    receiveBytes = 0;
    lastLoggedRecvPct = -1;
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
      const blob = receiveTarget
        ? new Blob(
            [receiveTarget.subarray(0, receiveBytes) as Uint8Array<ArrayBuffer>],
            {
              type: receiveMeta.mimeType || "application/octet-stream",
            }
          )
        : new Blob(receiveFallbackChunks, {
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

    return new Promise<void>((resolve, reject) => {
      abortSend = reject;

      currentSendFile = file;
      lastAckedOffset = startOffset;
      sendBytesQueued = startOffset;
      lastLoggedSendPct = -1;
      setTransferActive(true);
      startSendHeartbeat(file);

      const mbSize = (file.size / (1024 * 1024)).toFixed(1);
      debug(
        `send start: ${file.name} (${mbSize} MB, 64 KB chunks / 1 MB partitions)${startOffset ? ` from offset ${startOffset}` : ""}`
      );
      scheduleProgress(file.name, startOffset, file.size);

      if (startOffset === 0) {
        const meta: FileMetaMessage = {
          type: "meta",
          name: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
        };
        dc!.send(JSON.stringify(meta));
      }

      if (file.size === 0) {
        dc!.send(JSON.stringify({ type: "done" } satisfies FileDoneMessage));
        options.onFileSent?.({ name: file.name, size: file.size });
        currentSendFile = null;
        setTransferActive(false);
        resolve();
        return;
      }

      fileChunker = new FileChunker(
        file,
        startOffset,
        (chunk) => {
          sendRawChunk(file, chunk);
          lastLoggedSendPct = logTransferProgress(
            "send",
            sendBytesQueued,
            file.size,
            lastLoggedSendPct
          );
        },
        (offset) => onPartitionEnd(file, offset),
        () => {
          if (!dc || dc.readyState !== "open") {
            reject(new Error("Data channel closed during send"));
            return;
          }
          clearPartitionAckTimer();
          dc.send(JSON.stringify({ type: "done" } satisfies FileDoneMessage));
          debug(`send done: ${file.name}`);
          options.onFileSent?.({ name: file.name, size: file.size });
          stopFileChunker();
          currentSendFile = null;
          setTransferActive(false);
          resolve();
        },
        (error) => {
          stopFileChunker();
          currentSendFile = null;
          setTransferActive(false);
          reject(error);
        }
      );
      fileChunker.nextPartition();
    }).finally(() => {
      abortSend = null;
      stopSendHeartbeat();
      stopFileChunker();
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
          debug("⚠ TURN relay — expect slower speeds");
        } else if (
          local?.candidateType !== "host" ||
          remote?.candidateType !== "host"
        ) {
          debug(
            "⚠ not a direct LAN path — if both devices are on the same Wi‑Fi, speeds may be much slower than expected"
          );
        }
        if (pair.currentRoundTripTime) {
          debug(`ICE RTT: ${Math.round(pair.currentRoundTripTime * 1000)} ms`);
        }
        if (pair.availableOutgoingBitrate) {
          debug(
            `ICE estimated uplink: ${(pair.availableOutgoingBitrate / (1024 * 1024)).toFixed(1)} Mbps`
          );
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

      const turnAvailable = hasTurnServer(iceServers);
      debug(
        turnAvailable
          ? `ICE: ${iceServers.length} servers (STUN + TURN)`
          : `ICE: STUN only — add Cloudflare TURN on Vercel for better cross-network speeds`
      );

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
    if (progressFlushTimer) {
      clearTimeout(progressFlushTimer);
      progressFlushTimer = null;
    }
    stopSendHeartbeat();
    stopFileChunker();
    if (abortSend) {
      failActiveSend("Transfer cancelled");
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
