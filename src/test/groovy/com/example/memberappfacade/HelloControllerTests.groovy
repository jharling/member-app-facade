package com.example.memberappfacade

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.test.web.servlet.MockMvc

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

@SpringBootTest
@AutoConfigureMockMvc
class HelloControllerTests {

	@Autowired
	private MockMvc mockMvc

	@Test
	void helloReturnsHelloWorldMessage() {
		mockMvc.perform(get('/hello'))
				.andExpect(status().isOk())
				.andExpect(content().string('Hello, World!'))
	}

}
