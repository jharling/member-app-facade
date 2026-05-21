package com.example.memberappfacade.auth

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.cognitoidentityprovider.CognitoIdentityProviderClient

@Configuration
class CognitoConfig {

	@Bean
	CognitoIdentityProviderClient cognitoIdentityProviderClient(@Value('${aws.region}') String awsRegion) {
		CognitoIdentityProviderClient.builder()
				.region(Region.of(awsRegion))
				.build()
	}

}
