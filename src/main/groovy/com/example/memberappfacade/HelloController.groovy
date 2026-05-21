package com.example.memberappfacade

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@Tag(name = 'Hello')
class HelloController {

	private final HelloService helloService

	HelloController(HelloService helloService) {
		this.helloService = helloService
	}

	@GetMapping('/hello')
	@Operation(summary = 'Returns a hello world message')
	String hello() {
		helloService.message
	}

}
