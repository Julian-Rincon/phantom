import { describe, expect, it } from "vitest";
import { DICTS, getLang, setLang, t } from "./i18n";

describe("i18n", () => {
  it("every Spanish key has an English counterpart and vice versa", () => {
    const esKeys = Object.keys(DICTS.es).sort();
    const enKeys = Object.keys(DICTS.en).sort();
    expect(enKeys).toEqual(esKeys);
  });

  it("defaults to Spanish", () => {
    expect(getLang()).toBe("es");
    expect(t("tab.overview")).toBe("Resumen");
  });

  it("switches language", () => {
    setLang("en");
    expect(t("tab.overview")).toBe("Overview");
    setLang("es");
  });

  it("interpolates {vars}", () => {
    setLang("en");
    expect(t("limit.continueWith", { agent: "Claude Opus 5" })).toBe("Continue with Claude Opus 5");
    setLang("es");
  });

  it("falls back to the key itself when missing everywhere", () => {
    expect(t("nope.not.a.real.key")).toBe("nope.not.a.real.key");
  });
});
