import { describe, expect, it } from "vitest";
import { greetingName, welcomeText } from "./mail.js";

// The welcome email is the one message sent to whatever address was typed, so
// the greeting carries as little of the typed name as possible.
describe("welcome greeting", () => {
  it.each([
    ["Rosa Diaz", "Hi Rosa,"],
    ["Dr. Ngozi Okafor", "Hi Ngozi,"],
    ["J.Smith", "Hi there,"],
    ["Visit refund.icu now", "Hi Visit,"],
    ["A.J. B.", "Hi there,"],
  ])("greets %j as %j", (name, line) => {
    const { text } = welcomeText({ name, number: 7, removeUrl: "https://api.test/waitlist/remove?t=x" });
    expect(text.split("\n")[0]).toBe(line);
  });

  it("never puts a dotted word in the greeting", () => {
    expect(greetingName("secure.login.vip")).toBeNull();
    expect(greetingName("Pay x.bond")).toBe("Pay");
    // The name rule lets one-letter hosts through; the greeting keeps them out of the email.
    expect(welcomeText({ name: "x.bond", number: 1, removeUrl: "https://a.test/r" }).text).not.toContain("x.bond");
  });
});
