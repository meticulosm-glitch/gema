import { useEffect, useState, type ReactNode } from "react";

/** Router minimale basato su pathname (nginx ha già il fallback SPA su index.html). */
export function navigate(to: string) {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new Event("mapp-nav"));
}

export function usePath(): string {
  const [p, setP] = useState(window.location.pathname);
  useEffect(() => {
    const f = () => setP(window.location.pathname);
    window.addEventListener("popstate", f);
    window.addEventListener("mapp-nav", f);
    return () => { window.removeEventListener("popstate", f); window.removeEventListener("mapp-nav", f); };
  }, []);
  return p;
}

export function Link({ to, children, className, title }: { to: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <a
      href={to}
      className={className}
      title={title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
