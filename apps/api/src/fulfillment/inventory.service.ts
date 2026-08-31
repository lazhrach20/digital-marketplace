import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllocateKeyResult, InventoryPort } from '../domain/ports';
import { PrismaService } from '../prisma/prisma.service';

type InventoryCodeRow = { code: string };

/**
 * Shared-pool allocate (F4/F12): one unbound key per order, race-safe.
 *
 * Same `orderId` is serialized with `SELECT … FOR UPDATE` on `Order`.
 * Competing orders pick distinct free keys via `FOR UPDATE SKIP LOCKED`.
 */
@Injectable()
export class InventoryService implements InventoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async allocateForOrder(orderId: string): Promise<AllocateKeyResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
        `;

        const alreadyBound = await tx.inventoryKey.findUnique({
          where: { orderId },
        });
        if (alreadyBound) {
          return { status: 'ok', code: alreadyBound.code };
        }

        const unlocked = await tx.$queryRaw<InventoryCodeRow[]>`
          SELECT "code"
          FROM "InventoryKey"
          WHERE "orderId" IS NULL
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;

        const picked = unlocked[0];
        if (!picked) {
          return { status: 'out_of_stock' };
        }

        await tx.inventoryKey.update({
          where: { code: picked.code },
          data: { orderId },
        });

        return { status: 'ok', code: picked.code };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const bound = await this.prisma.inventoryKey.findUnique({
          where: { orderId },
        });
        if (bound) {
          return { status: 'ok', code: bound.code };
        }
      }
      throw error;
    }
  }
}
