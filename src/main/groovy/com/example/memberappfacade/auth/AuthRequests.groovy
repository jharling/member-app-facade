package com.example.memberappfacade.auth

class CreateAccountRequest {
	String email
	String password
	String givenName
	String familyName
}

class ConfirmCreateAccountRequest {
	String email
	String confirmationCode
}

class LoginRequest {
	String email
	String password
}

class ForgotPasswordRequest {
	String email
}

class ConfirmForgotPasswordRequest {
	String email
	String confirmationCode
	String newPassword
}
