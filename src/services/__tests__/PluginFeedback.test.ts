import { requestUrl } from "obsidian";
import { API_BASE_URL } from "../../constants/api";
import { sendPluginFeedback } from "../PluginFeedback";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), requestUrl: jest.fn() }));
const request = jest.mocked(requestUrl);

beforeEach(() => jest.clearAllMocks());

it.each([undefined, "  account-license  "])("posts only explicit feedback and version, with optional verified-account credentials (%s)", async license => {
  request.mockResolvedValue({ status: 202, text: '{"success":true,"queued":true}', headers: {} } as never);
  await sendPluginFeedback("  Please make audio easier.  ", "6.18.17", license);
  expect(request).toHaveBeenCalledTimes(1);
  const input = request.mock.calls[0][0];
  if (typeof input === "string") throw new Error("Expected structured native request");
  expect(input).toMatchObject({ url: `${API_BASE_URL}/feedback`, method: "POST" });
  expect(JSON.parse(input.body as string)).toEqual({ message: "Please make audio easier.", pluginVersion: "6.18.17" });
  expect(input.headers?.["x-license-key"]).toBe(license ? "account-license" : undefined);
});

it("rejects an empty draft without contacting the server", async () => {
  await expect(sendPluginFeedback(" \n ", "6.18.17")).rejects.toThrow("Write a message");
  expect(request).not.toHaveBeenCalled();
});

it.each([
  { status: 503, text: '{"success":false}' },
  { status: 202, text: '{"success":true}' },
  { status: 202, text: '{"queued":false}' },
  { status: 202, text: "invalid-json" },
])("does not claim success without a queue receipt: %j", async response => {
  request.mockResolvedValue({ ...response, headers: {} } as never);
  await expect(sendPluginFeedback("My feedback", "6.18.17")).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not automatically retry a failed send", async () => {
  request.mockRejectedValue(new Error("Connection lost"));
  await expect(sendPluginFeedback("My feedback", "6.18.17")).rejects.toThrow("Connection lost");
  expect(request).toHaveBeenCalledTimes(1);
});
