import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { PaymentWebhookDto } from './payment-webhook.dto';
import {
  HandlePaymentWebhookResult,
  PaymentsService,
} from './payments.service';

@Controller('webhooks')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('payment')
  @HttpCode(HttpStatus.OK)
  handlePaymentWebhook(
    @Body() dto: PaymentWebhookDto,
  ): Promise<HandlePaymentWebhookResult> {
    return this.paymentsService.handlePaymentWebhook(dto);
  }
}
