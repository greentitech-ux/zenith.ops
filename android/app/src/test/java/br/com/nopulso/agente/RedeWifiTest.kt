package br.com.nopulso.agente
import org.junit.Assert.*
import org.junit.Test

class RedeWifiTest {
  @Test fun ssidSaiSemAspasENuncaOEscondido() {
    assertEquals("LOJA-5G", RedeWifi.limparSsid("\"LOJA-5G\""))
    assertEquals("Loja Caixa", RedeWifi.limparSsid("  Loja Caixa "))
    assertNull(RedeWifi.limparSsid("<unknown ssid>"))
    assertNull(RedeWifi.limparSsid("0x"))
    assertNull(RedeWifi.limparSsid("\"\""))
    assertNull(RedeWifi.limparSsid(null))
    assertEquals(80, RedeWifi.limparSsid("x".repeat(200))!!.length)
  }

  @Test fun sinalNaMesmaReguaDoWindows() {
    // -100 dBm = 0%, -55 dBm = 100%, e nunca sai da faixa
    assertEquals(0, RedeWifi.sinalPorcento(-100))
    assertEquals(100, RedeWifi.sinalPorcento(-55))
    assertEquals(100, RedeWifi.sinalPorcento(-30))
    assertEquals(0, RedeWifi.sinalPorcento(-120))
    val meio = RedeWifi.sinalPorcento(-70)
    assertTrue("$meio", meio in 60..70)
  }
}
