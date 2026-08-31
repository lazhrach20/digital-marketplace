import { Injectable } from '@nestjs/common';
import { Prisma, ProviderRequest } from '@prisma/client';
import { FulfillmentOutcome, ProviderId } from '../domain/enums';
import { PrismaService } from '../prisma/prisma.service';

/** In-flight row before the stub has an issue outcome. */
export const PROVIDER_REQUEST_PENDING = 'pending';

/**
 * Durable `ProviderRequest` rows keyed by `requestId` (F4/F7).
 *
 * Created before the first issue attempt. Retries reuse the same row;
 * a stored `ok` + `code` is the provider-side success even if the caller
 * previously observed a timeout.
 */
@Injectable()
export class ProviderRequestStore {
  constructor(private readonly prisma: PrismaService) {}

  async findByRequestId(
    requestId: string,
  ): Promise<ProviderRequest | null> {
    return this.prisma.providerRequest.findUnique({
      where: { requestId },
    });
  }

  async getOrCreate(input: {
    requestId: string;
    orderId: string;
    provider: ProviderId;
  }): Promise<ProviderRequest> {
    const existing = await this.findByRequestId(input.requestId);
    if (existing) {
      return existing;
    }

    try {
      return await this.prisma.providerRequest.create({
        data: {
          requestId: input.requestId,
          orderId: input.orderId,
          provider: input.provider,
          outcome: PROVIDER_REQUEST_PENDING,
          code: null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.findByRequestId(input.requestId);
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  async markOutcome(
    requestId: string,
    outcome: FulfillmentOutcome,
    code: string | null = null,
  ): Promise<ProviderRequest> {
    return this.prisma.providerRequest.update({
      where: { requestId },
      data: { outcome, code },
    });
  }
}
