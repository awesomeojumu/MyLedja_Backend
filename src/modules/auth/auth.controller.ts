import { Controller } from '@nestjs/common';
import { Errors } from '../../common/errors/errors.js';
import { Route } from '../../common/http/contract.js';
import { authRoutes, meRoutes } from './auth.contract.js';

@Controller()
export class AuthController {
  @Route(authRoutes.signUp)
  signUp() {
    throw Errors.notImplemented();
  }

  @Route(authRoutes.resendCode)
  resendCode() {
    throw Errors.notImplemented();
  }

  @Route(authRoutes.verifyEmail)
  verifyEmail() {
    throw Errors.notImplemented();
  }

  @Route(authRoutes.signIn)
  signIn() {
    throw Errors.notImplemented();
  }

  @Route(authRoutes.google)
  google() {
    throw Errors.notImplemented();
  }

  @Route(authRoutes.refresh)
  refresh() {
    throw Errors.notImplemented();
  }

  @Route(authRoutes.signOut)
  signOut() {
    throw Errors.notImplemented();
  }

  @Route(authRoutes.signOutOthers)
  signOutOthers() {
    throw Errors.notImplemented();
  }

  @Route(authRoutes.recover)
  recover() {
    throw Errors.notImplemented();
  }

  @Route(authRoutes.newPassword)
  newPassword() {
    throw Errors.notImplemented();
  }

  @Route(meRoutes.me)
  me() {
    throw Errors.notImplemented();
  }
}
