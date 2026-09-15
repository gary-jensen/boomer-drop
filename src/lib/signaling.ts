export const ROOM_TTL = 600;

export type SignalMessageType = "offer" | "answer" | "ice" | "guest-ready";

export interface SignalMessage {
  type: SignalMessageType;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export type SignalRole = "host" | "guest";

export function otherRole(role: SignalRole): SignalRole {
  return role === "host" ? "guest" : "host";
}

export function validRoomId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function validRole(value: unknown): value is SignalRole {
  return value === "host" || value === "guest";
}
export function validSignal(value: unknown): value is SignalMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as SignalMessage;
  if (message.type === "guest-ready") return true;
  if (message.type === "offer" || message.type === "answer") {
    return message.sdp?.type === message.type && typeof message.sdp.sdp === "string";
  }
  return message.type === "ice" && !!message.candidate && typeof message.candidate.candidate === "string";
}
