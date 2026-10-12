import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PART 43.6 [483] / PART 43.7 [488] — the alert fan-out. Every alert reaches the
 * platform sink; email and ONE external webhook are optional, env-configured
 * add-ons. The sink NEVER throws (a delivery failure must not take down the
 * refresh/health path that raised the alert), and no secret is ever placed in a
 * message.
 */

const secretsMock = vi.hoisted(() => {
  const value: Record<string, string> = {
    PO_ALERT_EMAIL: "",
    PO_ALERT_WEBHOOK_URL: "",
  };
  return { value };
});
vi.mock("../../config/secrets", () => ({ secrets: secretsMock.value }));

const sinkMock = vi.hoisted(() => ({
  sendSystemAlert: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("../../services/notification.service", () => ({
  NotificationService: { getInstance: () => sinkMock },
}));

const axiosPost = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({
  default: { post: axiosPost },
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { poAlert } from "../../services/poAlert";

const params = {
  level: "critical" as const,
  title: "PO session dead",
  message: "no ticks for 16m",
};

beforeEach(() => {
  secretsMock.value.PO_ALERT_EMAIL = "";
  secretsMock.value.PO_ALERT_WEBHOOK_URL = "";
  sinkMock.sendSystemAlert.mockReset().mockResolvedValue(undefined);
  sinkMock.sendEmail.mockReset().mockResolvedValue(undefined);
  axiosPost.mockReset().mockResolvedValue({ status: 200 });
});

describe("poAlert fan-out ([483], webhook [488])", () => {
  it("always reaches the platform sink with level/title/message", async () => {
    await poAlert(params);
    expect(sinkMock.sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(sinkMock.sendSystemAlert).toHaveBeenCalledWith(params);
    expect(sinkMock.sendEmail).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it("emails PO_ALERT_EMAIL when configured", async () => {
    secretsMock.value.PO_ALERT_EMAIL = "oncall@example.com";
    await poAlert(params);
    expect(sinkMock.sendEmail).toHaveBeenCalledTimes(1);
    expect(sinkMock.sendEmail.mock.calls[0][0]).toMatchObject({
      to: "oncall@example.com",
    });
  });

  it("POSTs the external webhook when PO_ALERT_WEBHOOK_URL is set", async () => {
    secretsMock.value.PO_ALERT_WEBHOOK_URL = "https://hooks.example.com/abc";
    await poAlert(params);
    expect(axiosPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = axiosPost.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/abc");
    expect(body).toMatchObject({ level: "critical", title: "PO session dead" });
    expect(String(body.text)).toContain("PO session dead");
    expect(opts).toMatchObject({ timeout: expect.any(Number) });
  });

  it("never throws when every sink fails", async () => {
    secretsMock.value.PO_ALERT_EMAIL = "oncall@example.com";
    secretsMock.value.PO_ALERT_WEBHOOK_URL = "https://hooks.example.com/abc";
    sinkMock.sendSystemAlert.mockRejectedValueOnce(new Error("sink down"));
    sinkMock.sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    axiosPost.mockRejectedValueOnce(new Error("webhook down"));
    await expect(poAlert(params)).resolves.toBeUndefined();
  });
});
