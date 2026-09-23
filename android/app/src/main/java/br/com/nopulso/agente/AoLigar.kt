package br.com.nopulso.agente

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * O tablet reiniciou (ou o APK acabou de ser atualizado): sobe o agente de
 * novo, sem ninguem tocar no aparelho.
 *
 * E' a mesma licao das 52 maquinas Windows (CLAUDE.md §1): monitoramento que
 * depende de alguem ir ate a loja abrir um app nao e monitoramento. Sem isto,
 * uma queda de energia de madrugada deixaria o tablet fora do NOC ate o
 * gerente chegar - e o painel mostraria a loja offline o tempo todo.
 */
class AoLigar : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val acao = intent?.action ?: return
    if (acao != Intent.ACTION_BOOT_COMPLETED && acao != Intent.ACTION_MY_PACKAGE_REPLACED) return
    ServicoAgente.ligar(context)
  }
}
