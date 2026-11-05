"use client";

/**
 * Clean, static backdrop. Heavy animated 120px blur orbs and purple grids are
 * gone; the canvas lets the page content breathe without GPU compositor lag on
 * mobile screens.
 */
export default function AnimatedBackground() {
  return (
    <div className="fixed inset-0 -z-10 pointer-events-none bg-bg" aria-hidden="true" />
  );
}
