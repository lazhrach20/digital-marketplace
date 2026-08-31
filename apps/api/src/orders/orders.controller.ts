import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CreatedOrder, OrderDetail, OrdersService } from './orders.service';

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

  @Get(':id')
  findById(@Param('id') id: string): Promise<OrderDetail> {
    return this.ordersService.findById(id);
  }

  @Post(':id/retry-delivery')
  @HttpCode(HttpStatus.OK)
  retryDelivery(@Param('id') id: string): Promise<OrderDetail> {
    return this.ordersService.retryDelivery(id);
  }
}
