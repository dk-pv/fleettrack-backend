import {
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';

import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  @Get()
  test() {
    return {
      success: true,
      message: 'Auth API Working',
    };
  }

  @Post('login')
  login(@Body() body: any) {
    return this.authService.login(body);
  }
}