package com.example.memberappfacade.auth

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import software.amazon.awssdk.services.cognitoidentityprovider.model.CognitoIdentityProviderException
import software.amazon.awssdk.services.cognitoidentityprovider.model.NotAuthorizedException

@RestControllerAdvice
class AuthExceptionHandler {

	@ExceptionHandler(IllegalArgumentException)
	ResponseEntity<Map<String, Object>> handleValidation(IllegalArgumentException exception) {
		error(HttpStatus.BAD_REQUEST, exception.message)
	}

	@ExceptionHandler(IllegalStateException)
	ResponseEntity<Map<String, Object>> handleConfiguration(IllegalStateException exception) {
		error(HttpStatus.INTERNAL_SERVER_ERROR, exception.message)
	}

	@ExceptionHandler(NotAuthorizedException)
	ResponseEntity<Map<String, Object>> handleUnauthorized(NotAuthorizedException exception) {
		error(HttpStatus.UNAUTHORIZED, cognitoMessage(exception))
	}

	@ExceptionHandler(CognitoIdentityProviderException)
	ResponseEntity<Map<String, Object>> handleCognito(CognitoIdentityProviderException exception) {
		def status = HttpStatus.resolve(exception.statusCode()) ?: HttpStatus.BAD_REQUEST
		error(status, cognitoMessage(exception))
	}

	private static ResponseEntity<Map<String, Object>> error(HttpStatus status, String message) {
		ResponseEntity.status(status).body([
				error  : status.reasonPhrase,
				message: message
		])
	}

	private static String cognitoMessage(CognitoIdentityProviderException exception) {
		exception.awsErrorDetails()?.errorMessage() ?: exception.message
	}

}
