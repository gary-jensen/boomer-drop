BEGIN;
CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms (expires_at);
CREATE TABLE IF NOT EXISTS signals (
  id bigserial PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  recipient text NOT NULL CHECK (recipient IN ('host', 'guest')),
  message jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_delivery ON signals (room_id, recipient, id);
COMMIT;
