import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PaymentStatus } from '../domain/enums';
import { HandlePaymentWebhookResult } from '../payments/payments.service';
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

export class SimulatePaymentDto {
  @IsEnum(PaymentStatus)
  status!: PaymentStatus;
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

  @Post(':id/simulate-payment')
  @HttpCode(HttpStatus.OK)
  simulatePayment(
    @Param('id') id: string,
    @Body() dto: SimulatePaymentDto,
  ): Promise<HandlePaymentWebhookResult> {
    return this.ordersService.simulatePayment(id, dto.status);
  }
}
