import { Inter } from "next/font/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import ThemeBridge from "@/shared/components/ThemeBridge";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";

// First-paint theme + font-ready scripts, executed via ThemeBridge (a client
// component that appends them to <head> through the DOM API). Mirrors applyTheme()
// in store/themeStore.js: `dark` and `amoled` classes. Default theme is `amoled`.
const FIRST_PAINT_SCRIPT = [
  `(function(){try{var s=localStorage.getItem('theme');var st=s?(JSON.parse(s).state||{}):{};var t=st.theme||'amoled';var r=document.documentElement;if(t==='amoled'){r.classList.add('dark','amoled');r.setAttribute('data-theme','amoled');}else if(t==='dark'){r.classList.add('dark');r.classList.remove('amoled');r.removeAttribute('data-theme');}else{r.classList.remove('dark','amoled');r.removeAttribute('data-theme');}r.removeAttribute('data-palette');}catch(e){}})();`,
  // Mark the root "fonts-loaded" only when the Material Symbols webfont
  // actually finishes loading.
  `var d=document,r=d.documentElement,f=function(){r.classList.add('fonts-loaded')};if(d.fonts&&d.fonts.load){d.fonts.load('24px "Material Symbols Outlined"').then(f).catch(function(){});}else{f()}`,
].join("\n");

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata = {
  title: "9Router-Kiyoshi — AI Routing Gateway",
  description: "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
  icons: {
    icon: [
      { url: "/favicon.svg?v=2", type: "image/svg+xml" },
      { url: "/favicon.ico?v=2", sizes: "any" },
    ],
    shortcut: "/favicon.ico?v=2",
    apple: "/favicon-256.png?v=2",
  },
};

export const viewport = {
  themeColor: "#000000",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeBridge script={FIRST_PAINT_SCRIPT} />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider>
          <RuntimeI18nProvider>
            {children}
          </RuntimeI18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
