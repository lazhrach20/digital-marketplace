import { Body, Controller, Post } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CreatedOrder, OrdersService } from './orders.service';

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  sku!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  id?: string;
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto): Promise<CreatedOrder> {
    return this.ordersService.create(dto);
  }
}
