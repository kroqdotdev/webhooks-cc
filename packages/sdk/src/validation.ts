import type { MockResponse } from "./types";

export const MOCK_RESPONSE_STATUS_MIN = 100;
export const MOCK_RESPONSE_STATUS_MAX = 599;
export const MOCK_RESPONSE_DELAY_MIN = 0;
export const MOCK_RESPONSE_DELAY_MAX = 30000;

export function validateMockResponse(
  mockResponse: MockResponse,
  fieldName = "mock response"
): void {
  const { status, delay } = mockResponse;
  if (
    !Number.isInteger(status) ||
    status < MOCK_RESPONSE_STATUS_MIN ||
    status > MOCK_RESPONSE_STATUS_MAX
  ) {
    throw new Error(
      `Invalid ${fieldName} status: ${status}. Must be an integer ${MOCK_RESPONSE_STATUS_MIN}-${MOCK_RESPONSE_STATUS_MAX}.`
    );
  }
  if (
    delay !== undefined &&
    (!Number.isInteger(delay) || delay < MOCK_RESPONSE_DELAY_MIN || delay > MOCK_RESPONSE_DELAY_MAX)
  ) {
    throw new Error(
      `Invalid ${fieldName} delay: ${delay}. Must be an integer ${MOCK_RESPONSE_DELAY_MIN}-${MOCK_RESPONSE_DELAY_MAX}.`
    );
  }
}
