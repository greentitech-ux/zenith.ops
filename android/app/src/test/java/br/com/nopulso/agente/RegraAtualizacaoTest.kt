package br.com.nopulso.agente
import org.junit.Assert.*
import org.junit.Test

class RegraAtualizacaoTest {
  @Test fun novaVersaoAvisaUmaVez() {
    val url = "https://arquivos.example/nopulso.apk"
    assertTrue(RegraAtualizacao.deveAvisar(4, 5, 0, url))
    assertFalse(RegraAtualizacao.deveAvisar(4, 5, 5, url))
    assertTrue(RegraAtualizacao.deveAvisar(4, 6, 5, url))
    assertFalse(RegraAtualizacao.deveAvisar(4, 4, 0, url))
    assertFalse(RegraAtualizacao.deveAvisar(4, 3, 0, url))
    assertFalse(RegraAtualizacao.deveAvisar(4, 0, 0, url))
    for (invalida in listOf("", "http://inseguro.example/a.apk", "https://usuario:senha@exemplo/a.apk", "javascript:alert(1)")) assertFalse(RegraAtualizacao.deveAvisar(4, 5, 0, invalida))
    // Sabotagem: apagar o registro de aviso permitiria repetir a notificação.
    assertTrue(RegraAtualizacao.deveAvisar(4, 5, 0, url))
  }
}
