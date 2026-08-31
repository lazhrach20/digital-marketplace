import { Injectable } from '@nestjs/common';
import { FulfillmentOutcome, ProviderId } from '../domain/enums';
import {
  IssueProvider,
  IssueRequest,
  IssueResult,
} from '../domain/ports';
import { InventoryService } from './inventory.service';
import { ProviderRequestStore } from './provider-request.store';

const DEFAULT_TIMEOUT_MS = 3000;

function parseRate(raw: string | undefined): number {
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function parseTimeoutMs(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return value;
}

function parseEnvFlag(raw: string | undefined): boolean {
  return raw === '1';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * In-process primary provider (F4/F7). Simulates `POST /issue` without a listen.
 *
 * Timeout-after-issue: allocate and persist `ok` + `code` on the `ProviderRequest`
 * row **before** returning `{ status: 'timeout' }`, so a retry with the same
 * `requestId` returns that code and does not consume a second key.
 *
 * Deterministic flags (T6/T7/scripts; mutually exclusive with random rates):
 * - `PROVIDER_A_FORCE_TIMEOUT_THEN_OK=1` — first call times out after issue; retry → same code
 * - `PROVIDER_A_ALWAYS_DOWN=1` — every call returns simulated 5xx (no key allocation)
 */
@Injectable()
export class ProviderAAdapter implements IssueProvider {
  private readonly errorRate: number;
  private readonly timeoutRate: number;
  private readonly timeoutMs: number;
  private readonly forceTimeoutThenOk: boolean;
  private readonly alwaysDown: boolean;

  constructor(
    private readonly inventory: InventoryService,
    private readonly requests: ProviderRequestStore,
  ) {
    this.errorRate = parseRate(process.env.PROVIDER_A_ERROR_RATE);
    this.timeoutRate = parseRate(process.env.PROVIDER_A_TIMEOUT_RATE);
    this.timeoutMs = parseTimeoutMs(process.env.PROVIDER_TIMEOUT_MS);
    this.forceTimeoutThenOk = parseEnvFlag(
      process.env.PROVIDER_A_FORCE_TIMEOUT_THEN_OK,
    );
    this.alwaysDown = parseEnvFlag(process.env.PROVIDER_A_ALWAYS_DOWN);
  }

  async issue(request: IssueRequest): Promise<IssueResult> {
    const row = await this.requests.getOrCreate({
      requestId: request.requestId,
      orderId: request.orderId,
      provider: ProviderId.A,
    });

    if (row.outcome === FulfillmentOutcome.ok && row.code) {
      return {
        status: 'ok',
        requestId: request.requestId,
        code: row.code,
      };
    }

    if (this.alwaysDown) {
      await this.requests.markOutcome(
        request.requestId,
        FulfillmentOutcome.error,
      );
      return { status: 'error', reason: '5xx' };
    }

    if (this.forceTimeoutThenOk) {
      return this.issueThenTimeout(request);
    }

    if (Math.random() < this.timeoutRate) {
      return this.issueThenTimeout(request);
    }

    if (Math.random() < this.errorRate) {
      await this.requests.markOutcome(
        request.requestId,
        FulfillmentOutcome.error,
      );
      return { status: 'error', reason: '5xx' };
    }

    return this.allocateAndReturnOk(request);
  }

  private async allocateAndReturnOk(
    request: IssueRequest,
  ): Promise<IssueResult> {
    const allocated = await this.persistAllocate(request);
    if (allocated.status !== 'ok') {
      return allocated;
    }
    return {
      status: 'ok',
      requestId: request.requestId,
      code: allocated.code,
    };
  }

  /**
   * Provider-side issue succeeds (key bound + row `ok`), then the simulated
   * HTTP call exceeds {@link timeoutMs} so the caller observes `timeout`.
   */
  private async issueThenTimeout(
    request: IssueRequest,
  ): Promise<IssueResult> {
    const allocated = await this.persistAllocate(request);
    if (allocated.status !== 'ok') {
      return allocated;
    }
    await sleep(this.timeoutMs + 1);
    return { status: 'timeout' };
  }

  private async persistAllocate(
    request: IssueRequest,
  ): Promise<{ status: 'ok'; code: string } | IssueResult> {
    const allocated = await this.inventory.allocateForOrder(request.orderId);
    if (allocated.status === 'out_of_stock') {
      await this.requests.markOutcome(
        request.requestId,
        FulfillmentOutcome.out_of_stock,
      );
      return { status: 'error', reason: 'out_of_stock' };
    }

    await this.requests.markOutcome(
      request.requestId,
      FulfillmentOutcome.ok,
      allocated.code,
    );
    return { status: 'ok', code: allocated.code };
  }
}
