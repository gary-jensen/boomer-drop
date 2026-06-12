const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function getRoomCode(roomId: string): string {
  let hash = 0;
  for (let i = 0; i < roomId.length; i++) {
    hash = (hash << 5) - hash + roomId.charCodeAt(i);
    hash |= 0;
  }

  let code = "";
  let h = Math.abs(hash);
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[h % CODE_CHARS.length];
    h = Math.floor(h / CODE_CHARS.length);
  }
  return code;
}
