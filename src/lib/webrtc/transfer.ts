import type { SignalMessage } from "@/lib/signaling";
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

// 64 KB per message is the sweet spot for Safari/WebKit. Larger values
// (e.g. 256 KB) cause Safari's SCTP to process messages more slowly
// even when a higher max-message-size is negotiated in the SDP.
const CHUNK_SIZE = 64 * 1024;
// How many bytes to read from the File in one async call. Reading 4 MB at
// a time means one `await` per 64 chunks instead of one per chunk —
// eliminating the vast majority of async overhead on large files.
const READ_BATCH_SIZE = 4 * 1024 * 1024;
// Allow up to 8 MB in the send buffer before pausing. Modern browsers
// (Chrome, Firefox, Safari) all support buffers well above this.
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
// Resume sending once the buffer drains below 2 MB.
const BUFFERED_AMOUNT_LOW_THRESHOLD = 2 * 1024 * 1024;
const POLL_INTERVAL_MS = 300;
const GUEST_READY_RETRY_MS = 1500;
const ICE_GATHER_TIMEOUT_MS = 8000;

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
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let guestReadyTimer: ReturnType<typeof setInterval> | null = null;
  let messageIndex = 0;
  let destroyed = false;
  let offerCreated = false;
  let makingOffer = false;
  let remoteDescriptionSet = false;

  const pendingSignals: SignalMessage[] = [];
  const pendingIceCandidates: RTCIceCandidateInit[] = [];

  let receiveBuffer: ArrayBuffer[] = [];
  let receiveMeta: FileMetaMessage | null = null;
  let receiveBytes = 0;
  let lastProgressBytes = 0;
  let lanHost: string | null = null;

  // Only fire onProgress every 1 MB to avoid saturating the receiver's
  // JS thread with React state updates on large files.
  const PROGRESS_UPDATE_INTERVAL = 1 * 1024 * 1024;

  function debug(message: string): void {
    options.onDebug?.(message);
  }

  async function sendSignal(message: SignalMessage): Promise<boolean> {
    try {
      const response = await fetch(`/api/signal/${options.roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: options.role, message }),
      });
      if (!response.ok) {
        debug(`signal failed (${response.status}): ${message.type}`);
      }
      return response.ok;
    } catch (error) {
      debug(`signal error: ${message.type}`);
      return false;
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

  async function pollSignals(): Promise<void> {
    if (destroyed) return;

    try {
      const response = await fetch(
        `/api/signal/${options.roomId}?role=${options.role}&since=${messageIndex}`
      );
      if (!response.ok) {
        if (response.status === 404) {
          debug("room expired — rescan QR on host");
        }
        return;
      }

      const data = (await response.json()) as {
        messages: SignalMessage[];
        nextIndex: number;
      };

      for (const message of data.messages) {
        await handleSignal(message);
      }
      messageIndex = data.nextIndex;
    } catch {
      debug("poll error");
    }
  }

  async function sendLocalDescription(
    type: "offer" | "answer"
  ): Promise<boolean> {
    const local = pc?.localDescription;
    if (!local?.sdp) return false;

    const injectLan = options.role === "host" && type === "offer";
    const prepared = prepareSessionDescription(local, { lanHost, injectLan });
    debug(`${type} ${summarizeCandidates(prepared.sdp ?? "")}`);

    if (injectLan && lanHost && !prepared.sdp?.includes(lanHost)) {
      debug(`warning: could not inject ${lanHost}`);
    }

    if (!prepared.sdp?.includes("a=candidate:")) {
      debug("warning: no usable network candidates");
    }

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

  async function processPendingSignals(): Promise<void> {
    const queued = pendingSignals.splice(0);
    for (const message of queued) {
      await handleSignal(message);
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

  function resetReceiveState(): void {
    receiveBuffer = [];
    receiveMeta = null;
    receiveBytes = 0;
    lastProgressBytes = 0;
  }

  function abortReceive(reason: string): void {
    debug(`receive error: ${reason}`);
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

  function setupDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

    channel.onopen = () => {
      if (guestReadyTimer) {
        clearInterval(guestReadyTimer);
        guestReadyTimer = null;
      }
      debug("data channel open");
      options.onStatus("connected");
      void logCandidatePair();
    };

    channel.onclose = () => {
      debug("data channel closed");
    };

    channel.onerror = (event) => {
      debug(`data channel error: ${String(event)}`);
    };

    channel.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data === "string") {
        const parsed = JSON.parse(event.data) as
          | FileMetaMessage
          | FileDoneMessage;

        if (parsed.type === "meta") {
          resetReceiveState();
          receiveMeta = parsed;
          debug(
            `recv meta: ${parsed.name} (${(parsed.size / 1024).toFixed(1)} KB)`
          );
          return;
        }

        if (parsed.type === "done") {
          debug(
            `recv done: ${receiveMeta?.name ?? "?"} — got ${receiveBytes} / ${receiveMeta?.size ?? "?"} bytes`
          );
          finalizeReceivedFile();
        }
        return;
      }

      if (!receiveMeta) return;

      try {
        const chunk = event.data as ArrayBuffer;
        receiveBuffer.push(chunk);
        receiveBytes += chunk.byteLength;

        const pct = Math.round((receiveBytes / receiveMeta.size) * 100);
        if (pct % 25 === 0 || receiveBytes === receiveMeta.size) {
          debug(`recv ${pct}% (${(receiveBytes / (1024 * 1024)).toFixed(1)} / ${(receiveMeta.size / (1024 * 1024)).toFixed(1)} MB)`);
        }

        const isDone = receiveBytes >= receiveMeta.size;
        if (isDone || receiveBytes - lastProgressBytes >= PROGRESS_UPDATE_INTERVAL) {
          lastProgressBytes = receiveBytes;
          options.onProgress({
            fileName: receiveMeta.name,
            sent: receiveBytes,
            total: receiveMeta.size,
          });
        }
      } catch (error) {
        abortReceive(
          `Not enough memory to receive "${receiveMeta.name}". Try a smaller file or free up space on this device.`
        );
        debug(`chunk alloc error: ${String(error)}`);
      }
    };
  }

  function waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
        channel.removeEventListener("error", onError);
      };
      const onLow = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error("Data channel closed while waiting for buffer to drain")); };
      const onError = () => { cleanup(); reject(new Error("Data channel error while waiting for buffer to drain")); };
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose);
      channel.addEventListener("error", onError);
    });
  }

  async function sendFile(file: File): Promise<void> {
    if (!dc || dc.readyState !== "open") {
      throw new Error("Data channel is not open");
    }

    const mbSize = (file.size / (1024 * 1024)).toFixed(1);
    debug(`send start: ${file.name} (${mbSize} MB)`);

    const meta: FileMetaMessage = {
      type: "meta",
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    };
    dc.send(JSON.stringify(meta));

    let offset = 0;

    // Kick off the first batch read immediately so it's in flight before we
    // enter the loop. Each iteration then starts the NEXT read before sending
    // the current batch, overlapping disk I/O with network drain waits.
    let nextBatchPromise = file
      .slice(offset, Math.min(offset + READ_BATCH_SIZE, file.size))
      .arrayBuffer();

    while (offset < file.size) {
      const batchEnd = Math.min(offset + READ_BATCH_SIZE, file.size);
      const batch = await nextBatchPromise;

      // Pre-fetch the next batch while we send the current one.
      const nextOffset = batchEnd;
      if (nextOffset < file.size) {
        nextBatchPromise = file
          .slice(nextOffset, Math.min(nextOffset + READ_BATCH_SIZE, file.size))
          .arrayBuffer();
      }

      const batchView = new Uint8Array(batch);
      let batchPos = 0;

      while (batchPos < batch.byteLength) {
        if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          debug(`buffer full — pausing at ${((offset + batchPos) / (1024 * 1024)).toFixed(1)} MB`);
          // During this drain wait the next batch read runs concurrently.
          await waitForBufferDrain(dc);
        }
        const end = Math.min(batchPos + CHUNK_SIZE, batch.byteLength);
        dc.send(batchView.subarray(batchPos, end));
        batchPos = end;
      }

      offset = batchEnd;

      const pct = Math.round((offset / file.size) * 100);
      if (pct % 10 === 0 || offset >= file.size) {
        debug(`send ${pct}% (${(offset / (1024 * 1024)).toFixed(1)} / ${mbSize} MB)`);
      }

      options.onProgress({
        fileName: file.name,
        sent: offset,
        total: file.size,
      });
    }

    const done: FileDoneMessage = { type: "done" };
    dc.send(JSON.stringify(done));
    debug(`send done: ${file.name}`);
    options.onFileSent?.({ name: file.name, size: file.size });
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void pollSignals();
    }, POLL_INTERVAL_MS);
    void pollSignals();
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
    // Nomination is async — wait a tick before reading stats.
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
        // Different browsers use nominated, state="succeeded", or both.
        if (!pair.nominated && pair.state !== "succeeded") return;

        const local = reports.get(pair.localCandidateId ?? "") as
          | CandReport
          | undefined;
        const remote = reports.get(pair.remoteCandidateId ?? "") as
          | CandReport
          | undefined;

        const localType = local?.candidateType ?? "?";
        const remoteType = remote?.candidateType ?? "?";
        const localAddr = local?.address
          ? `${local.address}:${local.port}`
          : "?";
        const remoteAddr = remote?.address
          ? `${remote.address}:${remote.port}`
          : "?";

        debug(
          `ICE path: ${localType} (${localAddr}) ↔ ${remoteType} (${remoteAddr})`
        );
        if (pair.currentRoundTripTime != null) {
          debug(`RTT: ${(pair.currentRoundTripTime * 1000).toFixed(0)} ms`);
        }
        if (pair.availableOutgoingBitrate != null) {
          debug(
            `available bandwidth: ${(pair.availableOutgoingBitrate / 1_000_000).toFixed(1)} Mbps`
          );
        }
        if (localType === "relay" || remoteType === "relay") {
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
      const [iceServers, config] = await Promise.all([
        fetchIceServers(),
        fetch("/api/config")
          .then((response) => response.json() as Promise<{ lanHost?: string }>)
          .catch(() => ({ lanHost: null })),
      ]);
      lanHost = config.lanHost ?? null;
      if (lanHost && options.role === "host") {
        debug(`LAN host: ${lanHost}`);
      }
      if (destroyed) return;

      if (typeof RTCPeerConnection === "undefined") {
        debug("WebRTC not available in this browser");
        options.onStatus("failed");
        return;
      }

      pc = new RTCPeerConnection({
        iceServers,
        bundlePolicy: "max-bundle",
        iceCandidatePoolSize: 4,
      });

      pc.onicecandidate = (event) => {
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

      pc.onconnectionstatechange = () => {
        const state = pc?.connectionState;
        debug(`connection: ${state ?? "?"}`);
        if (state === "connected") {
          options.onStatus("connected");
          void logCandidatePair();
        } else if (state === "connecting") options.onStatus("connecting");
        else if (state === "failed") options.onStatus("failed");
        else if (state === "closed") options.onStatus("closed");
      };

      pc.oniceconnectionstatechange = () => {
        debug(`ice: ${pc?.iceConnectionState ?? "?"}`);
        if (pc?.iceConnectionState === "failed") {
          options.onStatus("failed");
        }
      };

      if (options.role === "host") {
        dc = pc.createDataChannel("files", { ordered: true });
        setupDataChannel(dc);
        debug("host ready");
      } else {
        pc.ondatachannel = (event) => {
          dc = event.channel;
          setupDataChannel(dc);
          debug("data channel received");
        };
      }

      await processPendingSignals();
      startPolling();

      if (options.role === "guest") {
        startGuestReadyRetries();
      }
    } catch (error) {
      debug(`init failed: ${String(error)}`);
      if (!destroyed) options.onStatus("failed");
    }
  }

  async function sendFiles(files: File[]): Promise<void> {
    for (const file of files) {
      await sendFile(file);
    }
  }

  function destroy(): void {
    destroyed = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (guestReadyTimer) {
      clearInterval(guestReadyTimer);
      guestReadyTimer = null;
    }
    dc?.close();
    pc?.close();
    dc = null;
    pc = null;
  }

  return {
    init,
    sendFiles,
    destroy,
  };
}
