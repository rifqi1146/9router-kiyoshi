"use client";
import { useRouter } from "next/navigation";
import Navigation from "./components/Navigation";
import HeroSection from "./components/HeroSection";
import FlowAnimation from "./components/FlowAnimation";
import HowItWorks from "./components/HowItWorks";
import Features from "./components/Features";
import GetStarted from "./components/GetStarted";
import Footer from "./components/Footer";

export default function LandingPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-bg text-text-main font-sans overflow-x-hidden antialiased">
      <Navigation />

      <main>
        <HeroSection />
        <div className="flex justify-center pb-12 sm:pb-16 px-4">
          <FlowAnimation />
        </div>

        <GetStarted />
        <HowItWorks />
        <Features />

        {/* CTA Section */}
        <section className="py-16 sm:py-24 px-4 sm:px-6 border-t border-border-subtle bg-surface/30">
          <div className="max-w-2xl mx-auto text-center">
            <h2 className="text-2xl sm:text-4xl font-semibold tracking-tight text-text-main mb-3">
              Route all local requests through one hub
            </h2>
            <p className="text-sm text-text-muted mb-8 leading-relaxed">
              Open source, self-hosted, running entirely on your machine.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                onClick={() => router.push("/dashboard")}
                className="w-full sm:w-auto min-h-[44px] px-8 rounded-control bg-brand-800 hover:bg-brand-700 text-white text-sm font-semibold transition-colors cursor-pointer"
              >
                Open dashboard
              </button>
              <a
                href="https://github.com/decolua/9router#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full sm:w-auto min-h-[44px] px-8 rounded-control border border-border bg-surface hover:bg-surface-2 text-text-main text-sm font-semibold transition-colors flex items-center justify-center cursor-pointer"
              >
                Read documentation
              </a>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
