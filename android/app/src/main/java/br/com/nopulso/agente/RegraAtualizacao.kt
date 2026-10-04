package br.com.nopulso.agente

import java.net.URI

object RegraAtualizacao {
  fun deveAvisar(instalada: Int, disponivel: Int, avisada: Int, url: String): Boolean {
    if (disponivel <= instalada || disponivel <= avisada) return false
    return try {
      val u = URI(url)
      u.scheme == "https" && !u.host.isNullOrBlank() && u.rawUserInfo == null
    } catch (_: Exception) { false }
  }
}
