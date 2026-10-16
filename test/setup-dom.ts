// Matcher jest-dom e pulizia tra un test e l'altro: servono solo ai file con `@vitest-environment jsdom`.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("style");
    document.title = "";
  }
});
