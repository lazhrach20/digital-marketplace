import { Controller, Get } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('products')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  listProducts() {
    return this.catalogService.listProducts();
  }
}
