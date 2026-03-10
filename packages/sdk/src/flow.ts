import { NotFoundError } from "./errors";
import { verifySignature } from "./verify";
import type {
  CreateEndpointOptions,
  Endpoint,
  MockResponse,
  Request,
  SendOptions,
  SendTemplateOptions,
  SignatureVerificationResult,
  VerifySignatureOptions,
  WaitForOptions,
} from "./types";

interface FlowClient {
  endpoints: {
    create(options?: CreateEndpointOptions): Promise<Endpoint>;
    update(
      slug: string,
      options: {
        name?: string;
        mockResponse?: MockResponse | null;
      }
    ): Promise<Endpoint>;
    delete(slug: string): Promise<void>;
    send(slug: string, options?: SendOptions): Promise<Response>;
    sendTemplate(slug: string, options: SendTemplateOptions): Promise<Response>;
  };
  requests: {
    waitFor(slug: string, options?: WaitForOptions): Promise<Request>;
    replay(requestId: string, targetUrl: string): Promise<Response>;
  };
}

type FlowSendStep =
  | { kind: "send"; options: SendOptions }
  | { kind: "sendTemplate"; options: SendTemplateOptions };

export type WebhookFlowVerifyOptions =
  | {
      provider: Exclude<VerifySignatureOptions["provider"], "discord">;
      secret: string;
      /**
       * Signed URL override.
       * For Twilio, the endpoint URL is used automatically when omitted.
       */
      url?: string | ((endpoint: Endpoint, request: Request) => string);
    }
  | {
      provider: "discord";
      publicKey: string;
      url?: string | ((endpoint: Endpoint, request: Request) => string);
    };

export interface WebhookFlowResult {
  endpoint: Endpoint;
  request?: Request;
  verification?: SignatureVerificationResult;
  replayResponse?: Response;
  cleanedUp: boolean;
}

export class WebhookFlowBuilder {
  private createOptions: CreateEndpointOptions = {};
  private mockResponse: MockResponse | null | undefined;
  private sendStep: FlowSendStep | undefined;
  private waitOptions: WaitForOptions | undefined;
  private verificationOptions: WebhookFlowVerifyOptions | undefined;
  private replayTargetUrl: string | undefined;
  private deleteAfterRun = false;

  constructor(private readonly client: FlowClient) {}

  createEndpoint(options: CreateEndpointOptions = {}): this {
    this.createOptions = { ...this.createOptions, ...options };
    return this;
  }

  setMock(mockResponse: MockResponse | null): this {
    this.mockResponse = mockResponse;
    return this;
  }

  send(options: SendOptions = {}): this {
    this.sendStep = { kind: "send", options };
    return this;
  }

  sendTemplate(options: SendTemplateOptions): this {
    this.sendStep = { kind: "sendTemplate", options };
    return this;
  }

  waitForCapture(options: WaitForOptions = {}): this {
    this.waitOptions = options;
    return this;
  }

  verifySignature(options: WebhookFlowVerifyOptions): this {
    this.verificationOptions = options;
    return this;
  }

  replayTo(targetUrl: string): this {
    this.replayTargetUrl = targetUrl;
    return this;
  }

  cleanup(): this {
    this.deleteAfterRun = true;
    return this;
  }

  async run(): Promise<WebhookFlowResult> {
    let endpoint: Endpoint | undefined;
    let result: WebhookFlowResult | undefined;
    let request: Request | undefined;

    try {
      endpoint = await this.client.endpoints.create(this.createOptions);

      if (this.mockResponse !== undefined) {
        await this.client.endpoints.update(endpoint.slug, {
          mockResponse: this.mockResponse,
        });
      }

      if (this.sendStep?.kind === "send") {
        await this.client.endpoints.send(endpoint.slug, this.sendStep.options);
      }
      if (this.sendStep?.kind === "sendTemplate") {
        await this.client.endpoints.sendTemplate(endpoint.slug, this.sendStep.options);
      }

      if (this.waitOptions) {
        request = await this.client.requests.waitFor(endpoint.slug, this.waitOptions);
      }

      let verification: SignatureVerificationResult | undefined;
      if (this.verificationOptions) {
        if (!request) {
          throw new Error("Flow verification requires waitForCapture() to run first");
        }

        const resolvedUrl =
          typeof this.verificationOptions.url === "function"
            ? this.verificationOptions.url(endpoint, request)
            : (this.verificationOptions.url ??
              (this.verificationOptions.provider === "twilio" ? endpoint.url : undefined));

        if (this.verificationOptions.provider === "discord") {
          verification = await verifySignature(request, {
            provider: "discord",
            publicKey: this.verificationOptions.publicKey,
          });
        } else {
          verification = await verifySignature(request, {
            provider: this.verificationOptions.provider,
            secret: this.verificationOptions.secret,
            ...(resolvedUrl ? { url: resolvedUrl } : {}),
          });
        }
      }

      let replayResponse: Response | undefined;
      if (this.replayTargetUrl) {
        if (!request) {
          throw new Error("Flow replay requires waitForCapture() to run first");
        }
        replayResponse = await this.client.requests.replay(request.id, this.replayTargetUrl);
      }

      result = {
        endpoint,
        request,
        verification,
        replayResponse,
        cleanedUp: false,
      };
      return result;
    } finally {
      if (this.deleteAfterRun && endpoint) {
        try {
          await this.client.endpoints.delete(endpoint.slug);
          if (result) {
            result.cleanedUp = true;
          }
        } catch (error) {
          if (error instanceof NotFoundError) {
            // Endpoint already deleted — treat as cleaned up
            if (result) {
              result.cleanedUp = true;
            }
          }
          // Swallow cleanup errors to preserve the original exception
        }
      }
    }
  }
}
