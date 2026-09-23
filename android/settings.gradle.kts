// Projeto do agente Android do NoPulso. Fica FORA de server/ de proposito: o
// Render so publica o server, e o Gradle nunca pode entrar no caminho do
// deploy (ver CLAUDE.md §4).
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
  }
}
rootProject.name = "nopulso-agente"
include(":app")
