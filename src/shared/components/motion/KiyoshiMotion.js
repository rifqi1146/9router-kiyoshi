"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView, useSpring, useTransform } from "motion/react";
import { cn } from "@/shared/utils/cn";

/**
 * Kiyoshi Motion System — unified physics, easing, and reusable primitives.
 * Every page, card grid, list, and metric counter shares these exact curves.
 */

export const KIYOSHI_EASE = [0.16, 1, 0.3, 1];

export const KIYOSHI_SPRING = {
  type: "spring",
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};

export const KIYOSHI_SPRING_SNAPPY = {
  type: "spring",
  stiffness: 500,
  damping: 34,
};

export const pageVariants = {
  initial: { opacity: 0, y: 10 },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.28,
      ease: KIYOSHI_EASE,
      when: "beforeChildren",
      staggerChildren: 0.045,
    },
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: { duration: 0.16, ease: "easeIn" },
  },
};

export const staggerContainerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.045,
      delayChildren: 0.03,
    },
  },
};

export const staggerItemVariants = {
  hidden: { opacity: 0, y: 12, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.28,
      ease: KIYOSHI_EASE,
    },
  },
};

/**
 * PageTransition — wraps every route view inside DashboardLayout.
 * Gives every page a consistent, unmistakable Kiyoshi entrance.
 */
export function PageTransition({ children, routeKey, className }) {
  return (
    <motion.div
      key={routeKey}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: KIYOSHI_EASE }}
      className={cn("w-full", className)}
    >
      {children}
    </motion.div>
  );
}

/**
 * StaggerGrid — animates a grid of cards or items sequentially on mount/scroll.
 */
export function StaggerGrid({ children, className, delay = 0 }) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        hidden: { opacity: 0 },
        visible: {
          opacity: 1,
          transition: {
            staggerChildren: 0.04,
            delayChildren: delay,
          },
        },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/**
 * StaggerItem — child item inside StaggerGrid or StaggerList.
 */
export function StaggerItem({ children, className }) {
  return (
    <motion.div variants={staggerItemVariants} className={className}>
      {children}
    </motion.div>
  );
}

/**
 * ScrollReveal — reveals sections smoothly as they enter the viewport.
 */
export function ScrollReveal({ children, className, delay = 0 }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.12 });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 18 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }}
      transition={{ duration: 0.36, delay, ease: KIYOSHI_EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/**
 * AnimatedNumber — smooth spring-interpolated numeric counter.
 * Preserves exact formatting (no abbreviations) while rolling smoothly on updates.
 */
export function AnimatedNumber({ value, format = (n) => String(Math.round(n)), className }) {
  const numeric = Number(value) || 0;
  const spring = useSpring(numeric, { stiffness: 120, damping: 22, mass: 0.8 });
  const display = useTransform(spring, (latest) => format(latest));
  const [text, setText] = useState(() => format(numeric));

  useEffect(() => {
    spring.set(numeric);
  }, [numeric, spring]);

  useEffect(() => {
    const unsub = display.on("change", (v) => setText(v));
    return () => unsub();
  }, [display]);

  return <span className={cn("tabular-nums", className)}>{text}</span>;
}

/**
 * InteractiveCard — tactile card wrapper with subtle lift and press feedback.
 */
export function InteractiveCard({ children, className, onClick, ...props }) {
  return (
    <motion.div
      whileHover={{ y: -2, transition: { duration: 0.18, ease: KIYOSHI_EASE } }}
      whileTap={{ scale: 0.985, transition: { duration: 0.1 } }}
      onClick={onClick}
      className={cn("cursor-pointer", className)}
      {...props}
    >
      {children}
    </motion.div>
  );
}
