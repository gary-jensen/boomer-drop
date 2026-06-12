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

export function queueKey(roomId: string, role: SignalRole): string {
  return `room:${roomId}:queue:${role}`;
}

export function roomMetaKey(roomId: string): string {
  return `room:${roomId}:meta`;
}
