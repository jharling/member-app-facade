package com.example.memberappfacade.auth

import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import software.amazon.awssdk.services.cognitoidentityprovider.CognitoIdentityProviderClient
import software.amazon.awssdk.services.cognitoidentityprovider.model.AttributeType
import software.amazon.awssdk.services.cognitoidentityprovider.model.AuthFlowType
import software.amazon.awssdk.services.cognitoidentityprovider.model.ConfirmForgotPasswordRequest as AwsConfirmForgotPasswordRequest
import software.amazon.awssdk.services.cognitoidentityprovider.model.ConfirmSignUpRequest
import software.amazon.awssdk.services.cognitoidentityprovider.model.ForgotPasswordRequest as AwsForgotPasswordRequest
import software.amazon.awssdk.services.cognitoidentityprovider.model.InitiateAuthRequest
import software.amazon.awssdk.services.cognitoidentityprovider.model.SignUpRequest

@Service
class AuthService {

	private final CognitoIdentityProviderClient cognito
	private final String userPoolClientId

	AuthService(
			CognitoIdentityProviderClient cognito,
			@Value('${cognito.user-pool-client-id}') String userPoolClientId
	) {
		this.cognito = cognito
		this.userPoolClientId = userPoolClientId
	}

	Map<String, Object> createAccount(CreateAccountRequest request) {
		validateConfigured()
		def email = required(request.email, 'email')
		def password = required(request.password, 'password')

		def attributes = [
				AttributeType.builder().name('email').value(email).build()
		]
		if (request.givenName) {
			attributes << AttributeType.builder().name('given_name').value(request.givenName).build()
		}
		if (request.familyName) {
			attributes << AttributeType.builder().name('family_name').value(request.familyName).build()
		}

		def response = cognito.signUp(SignUpRequest.builder()
				.clientId(userPoolClientId)
				.username(email)
				.password(password)
				.userAttributes(attributes)
				.build())

		[
				userSub        : response.userSub(),
				confirmed      : response.userConfirmed(),
				codeDelivery   : response.codeDeliveryDetails()?.destination(),
				deliveryMedium : response.codeDeliveryDetails()?.deliveryMediumAsString()
		]
	}

	Map<String, Object> confirmCreateAccount(ConfirmCreateAccountRequest request) {
		validateConfigured()

		cognito.confirmSignUp(ConfirmSignUpRequest.builder()
				.clientId(userPoolClientId)
				.username(required(request.email, 'email'))
				.confirmationCode(required(request.confirmationCode, 'confirmationCode'))
				.build())

		[confirmed: true]
	}

	Map<String, Object> login(LoginRequest request) {
		validateConfigured()

		def response = cognito.initiateAuth(InitiateAuthRequest.builder()
				.clientId(userPoolClientId)
				.authFlow(AuthFlowType.USER_PASSWORD_AUTH)
				.authParameters([
						USERNAME: required(request.email, 'email'),
						PASSWORD: required(request.password, 'password')
				])
				.build())

		def auth = response.authenticationResult()
		[
				accessToken : auth?.accessToken(),
				idToken     : auth?.idToken(),
				refreshToken: auth?.refreshToken(),
				expiresIn   : auth?.expiresIn(),
				tokenType   : auth?.tokenType()
		]
	}

	Map<String, Object> forgotPassword(ForgotPasswordRequest request) {
		validateConfigured()

		def response = cognito.forgotPassword(AwsForgotPasswordRequest.builder()
				.clientId(userPoolClientId)
				.username(required(request.email, 'email'))
				.build())

		[
				codeDelivery  : response.codeDeliveryDetails()?.destination(),
				deliveryMedium: response.codeDeliveryDetails()?.deliveryMediumAsString()
		]
	}

	Map<String, Object> confirmForgotPassword(ConfirmForgotPasswordRequest request) {
		validateConfigured()

		cognito.confirmForgotPassword(AwsConfirmForgotPasswordRequest.builder()
				.clientId(userPoolClientId)
				.username(required(request.email, 'email'))
				.confirmationCode(required(request.confirmationCode, 'confirmationCode'))
				.password(required(request.newPassword, 'newPassword'))
				.build())

		[passwordChanged: true]
	}

	private void validateConfigured() {
		if (!userPoolClientId) {
			throw new IllegalStateException('COGNITO_USER_POOL_CLIENT_ID is not configured')
		}
	}

	private static String required(String value, String fieldName) {
		if (!value) {
			throw new IllegalArgumentException("${fieldName} is required")
		}
		value
	}

}
