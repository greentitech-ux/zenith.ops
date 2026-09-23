package br.com.nopulso.agente

import android.content.Context

/**
 * QUEM ESTE APARELHO E, no NOC.
 *
 * Mesma identidade das 52 maquinas Windows: unidade + posto + token do agente
 * (ver lojaStatus.js). O aparelho NAO escolhe quem e' - quem diz e' o link de
 * inscricao que o NOC gera, igual ao comando de instalacao do NOCZenith.
 *
 * Fica em SharedPreferences por um motivo pratico: sobrevive a fechar o app,
 * a reiniciar o tablet e a atualizar o APK. E' o equivalente do localStorage
 * que o quiosque do navegador ja usava - e vale a MESMA licao do CLAUDE.md
 * §4 item 3: se isso se perder, o tablet esquece qual unidade monitora e a
 * loja passa a acusar offline sem nada ter acontecido.
 */
object Identidade {
  private const val ARQUIVO = "nopulso_agente"
  private const val K_UNIDADE = "unidade"
  private const val K_POSTO = "posto"
  private const val K_TOKEN = "token"
  private const val K_BASE = "base"

  /** Endereco padrao - o mesmo fallback do APP_BASE_URL do servidor. */
  const val BASE_PADRAO = "https://adyen-monitor.onrender.com"

  private fun prefs(ctx: Context) =
    ctx.applicationContext.getSharedPreferences(ARQUIVO, Context.MODE_PRIVATE)

  fun salvar(ctx: Context, unidade: String, posto: String, token: String?, base: String?) {
    prefs(ctx).edit()
      .putString(K_UNIDADE, unidade)
      .putString(K_POSTO, posto)
      .putString(K_TOKEN, token ?: "")
      .putString(K_BASE, if (base.isNullOrBlank()) BASE_PADRAO else base)
      .apply()
  }

  fun unidade(ctx: Context): String = prefs(ctx).getString(K_UNIDADE, "") ?: ""
  fun posto(ctx: Context): String = prefs(ctx).getString(K_POSTO, "") ?: ""
  fun token(ctx: Context): String = prefs(ctx).getString(K_TOKEN, "") ?: ""
  fun base(ctx: Context): String = prefs(ctx).getString(K_BASE, BASE_PADRAO) ?: BASE_PADRAO

  /** Sem unidade nao ha o que monitorar - o app so mostra a tela de inscricao. */
  fun inscrito(ctx: Context): Boolean = unidade(ctx).isNotBlank()
}
