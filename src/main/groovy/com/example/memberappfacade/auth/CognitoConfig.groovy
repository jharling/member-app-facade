package com.example.memberappfacade.auth

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import software.amazon.awssdk.services.cognitoidentityprovider.CognitoIdentityProviderClient

@Configuration
class CognitoConfig {

	@Bean
	CognitoIdentityProviderClient cognitoIdentityProviderClient() {
		CognitoIdentityProviderClient.create()
	}

}
