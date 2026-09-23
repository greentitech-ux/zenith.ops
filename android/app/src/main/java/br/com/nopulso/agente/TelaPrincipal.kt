package br.com.nopulso.agente

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * A UNICA TELA DO APP - e ela e' quase so uma confirmacao.
 *
 * O tablet nao escolhe qual loja monitora: quem diz e' o link que o NOC
 * gera (ver "+ Computador" em loja-status.html), no formato
 * nopulso://inscrever?u=CODIGO&p=POSTO&t=TOKEN. Abrir esse link no tablet
 * inscreve o agente e ja liga o servico - ninguem digita codigo de unidade
 * numa tela de celular, que e' de onde sai erro de digitacao que depois vira
 * "loja fantasma" no painel.
 *
 * Aberto sem link (pelo icone), o app so mostra o que esta monitorando. Nao
 * ha o que configurar aqui de proposito: configuracao em tela de loja e'
 * configuracao que alguem muda sem querer.
 */
class TelaPrincipal : android.app.Activity() {

  private lateinit var texto: TextView

  override fun onCreate(estado: Bundle?) {
    super.onCreate(estado)

    val caixa = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setBackgroundColor(Color.parseColor("#0b0d10"))
      setPadding(48, 48, 48, 48)
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
      )
    }
    val titulo = TextView(this).apply {
      text = "NoPulso"
      textSize = 28f
      // o limao da marca; aqui e' codigo nativo, nao CSS - o token do tema
      // (CLAUDE.md §2) nao alcanca o Android
      setTextColor(Color.parseColor("#b8ff3c"))
      gravity = Gravity.CENTER
    }
    texto = TextView(this).apply {
      textSize = 16f
      setTextColor(Color.parseColor("#e7ecf1"))
      gravity = Gravity.CENTER
      setPadding(0, 32, 0, 0)
    }
    caixa.addView(titulo)
    caixa.addView(texto)
    setContentView(caixa)

    pedirPermissaoDeNotificacao()
    tratarLink(intent)
    mostrarEstado()
  }

  override fun onNewIntent(novo: Intent?) {
    super.onNewIntent(novo)
    intent = novo
    tratarLink(novo)
    mostrarEstado()
  }

  /** nopulso://inscrever?u=CODIGO&p=POSTO&t=TOKEN[&b=ENDERECO] */
  private fun tratarLink(intent: Intent?) {
    val dados: Uri = intent?.data ?: return
    if (dados.scheme != "nopulso" || dados.host != "inscrever") return
    val unidade = dados.getQueryParameter("u")?.trim().orEmpty()
    if (unidade.isBlank()) return
    Identidade.salvar(
      this,
      unidade,
      dados.getQueryParameter("p")?.trim().orEmpty(),
      dados.getQueryParameter("t")?.trim(),
      dados.getQueryParameter("b")?.trim()
    )
    ServicoAgente.ligar(this)
  }

  private fun mostrarEstado() {
    texto.text = if (Identidade.inscrito(this)) {
      val posto = Identidade.posto(this)
      "Monitorando a unidade ${Identidade.unidade(this)}" +
        (if (posto.isNotBlank()) "\ncomputador $posto" else "") +
        "\n\nPode fechar esta tela: o agente continua batendo presenca sozinho."
    } else {
      "Este aparelho ainda nao foi inscrito.\n\n" +
        "Abra no tablet o link de inscricao que o NOC gera em\n" +
        "Status das lojas > + Computador."
    }
  }

  /**
   * Android 13+ exige permissao pra notificacao - e sem notificacao o servico
   * em primeiro plano nao existe. Negar aqui nao trava nada: o servico ainda
   * sobe, so fica mais exposto a ser morto pelo sistema.
   */
  private fun pedirPermissaoDeNotificacao() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val jaTem = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
    if (jaTem == PackageManager.PERMISSION_GRANTED) return
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
  }
}
