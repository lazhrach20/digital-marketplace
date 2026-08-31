import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ProductListItem = {
  sku: string;
  name: string;
  type: string;
  price: number;
  currency: string;
  image: string;
  stock: number;
};

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(): Promise<ProductListItem[]> {
    const [products, unboundKeyCount] = await Promise.all([
      this.prisma.product.findMany({ orderBy: { sku: 'asc' } }),
      this.prisma.inventoryKey.count({ where: { orderId: null } }),
    ]);

    return products.map((product) => ({
      sku: product.sku,
      name: product.name,
      type: product.type,
      price: product.price,
      currency: product.currency,
      image: product.image,
      stock: unboundKeyCount,
    }));
  }
}
