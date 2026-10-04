package br.com.nopulso.agente

import org.junit.Assert.*
import org.junit.Test
import java.net.Socket

class ValidadorLocalTest {
  @Test fun provaLocalReal() {
    var dados = ValidadorLocal.Dados("https://www.nopulso.com.br", "Dom Praça", "TABLET1", "segredo-teste")
    val validador = ValidadorLocal({ dados }, 0)
    validador.iniciar()
    val porta = validador.portaAtiva
    assertTrue(porta > 0)
    fun chamar(origem: String = dados.origem, host: String = "127.0.0.1:$porta", metodo: String = "POST", corpo: String = "{\"desafio\":\"${"a".repeat(40)}\"}"): String {
      return Socket("127.0.0.1", porta).use { s ->
        s.soTimeout = 4000
        val pedido = "$metodo /validar HTTP/1.1\r\nHost: $host\r\nOrigin: $origem\r\nContent-Type: application/json\r\nContent-Length: ${corpo.toByteArray().size}\r\n\r\n$corpo"
        s.getOutputStream().write(pedido.toByteArray())
        s.getInputStream().bufferedReader().readText()
      }
    }
    try {
      val resposta = chamar()
      assertTrue(resposta.startsWith("HTTP/1.1 200"))
      assertTrue(resposta.contains("53f6398624514e01e77847e21dd6eca9efdb70a90abb1d0ddb920f0682e793cc"))
      assertTrue(resposta.contains("Dom Praça"))
      assertFalse(resposta.contains("segredo-teste"))
      assertTrue(chamar(metodo="OPTIONS").startsWith("HTTP/1.1 204"))
      assertTrue(chamar(origem="https://malicioso.example").startsWith("HTTP/1.1 403"))
      assertTrue(chamar(host="localhost:$porta").startsWith("HTTP/1.1 403"))
      assertEquals("",chamar(corpo="{\"desafio\":\"curto\"}"))
      assertEquals("",chamar(corpo="x".repeat(4097)))
      dados = dados.copy(token="")
      assertTrue(chamar().startsWith("HTTP/1.1 403"))
      // Sabotagem: permitir origem estranha quebraria a expectativa anterior.
      dados = dados.copy(origem="https://malicioso.example",token="segredo-teste")
      assertFalse(chamar(origem="https://malicioso.example").startsWith("HTTP/1.1 403"))
    } finally { validador.parar() }
  }
}
