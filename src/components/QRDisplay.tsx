"use client";

import { useEffect, useRef } from "react";
import QRCode from "qrcode";

interface QRDisplayProps {
  joinUrl: string;
}

export function QRDisplay({ joinUrl }: QRDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const size =
      typeof window !== "undefined" && window.innerWidth < 640 ? 196 : 216;

    void QRCode.toCanvas(canvas, joinUrl, {
      width: size,
      margin: 1,
      color: {
        dark: "#171a1f",
        light: "#ffffff",
      },
    });
  }, [joinUrl]);

  return (
    <div className="flex flex-col items-center justify-center p-6 sm:p-8">
      <p className="mb-5 text-center text-xl font-semibold text-ink">
        Scan with your camera
      </p>
      <div className="rounded-3xl border border-line bg-white p-4 shadow-[0_8px_24px_-8px_rgba(16,24,40,0.18)]">
        <canvas
          ref={canvasRef}
          className="block"
          role="img"
          aria-label="QR code to join"
        />
      </div>
    </div>
  );
}
