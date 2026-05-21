package com.example.memberappfacade.auth

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping('/accounts')
@Tag(name = 'Accounts')
class AuthController {

	private final AuthService authService

	AuthController(AuthService authService) {
		this.authService = authService
	}

	@PostMapping
	@Operation(operationId = 'createAccount', summary = 'Creates a new account in Cognito')
	Map<String, Object> createAccount(@RequestBody CreateAccountRequest request) {
		authService.createAccount(request)
	}

	@PostMapping('/confirm')
	@Operation(operationId = 'confirmCreateAccount', summary = 'Confirms a newly created Cognito account')
	Map<String, Object> confirmCreateAccount(@RequestBody ConfirmCreateAccountRequest request) {
		authService.confirmCreateAccount(request)
	}

	@PostMapping('/login')
	@Operation(operationId = 'login', summary = 'Logs in to Cognito with email and password')
	Map<String, Object> login(@RequestBody LoginRequest request) {
		authService.login(request)
	}

	@PostMapping('/forgot-password')
	@Operation(operationId = 'forgotPassword', summary = 'Starts the Cognito forgot password flow')
	Map<String, Object> forgotPassword(@RequestBody ForgotPasswordRequest request) {
		authService.forgotPassword(request)
	}

	@PostMapping('/forgot-password/confirm')
	@Operation(operationId = 'confirmForgotPassword', summary = 'Confirms the Cognito forgot password flow')
	Map<String, Object> confirmForgotPassword(@RequestBody ConfirmForgotPasswordRequest request) {
		authService.confirmForgotPassword(request)
	}

}
