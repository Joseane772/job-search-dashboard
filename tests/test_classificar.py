import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "painel"))
from classificar import associar, classificar, nucleo_empresa, tipo_de  # noqa: E402

CANDS = [
    {"id": "acme-dev", "empresa": "ACME Software Lda", "estado": "enviada", "enviada": "2026-10-01"},
    {"id": "nordtel", "empresa": "Nordtel AB", "estado": "enviada", "enviada": "2026-10-10", "dominios": ["talentplatform.io"]},
    {"id": "nordtel-velha", "empresa": "Nordtel AB", "estado": "fechada", "enviada": "2026-05-01"},
    {"id": "loja", "empresa": "Livraria Central (via agência)", "estado": "rascunho"},
    {"id": "anon", "empresa": "Empresa não identificada (IEFP)", "estado": "triagem"},
]


class Tipo(unittest.TestCase):
    def test_recusa_ganha_ao_agradecimento(self):
        self.assertEqual(tipo_de("hr@acme.pt", "Candidatura", "Obrigado pela tua candidatura. Infelizmente não iremos dar seguimento."), "recusa")

    def test_recusa_em_ingles(self):
        self.assertEqual(tipo_de("jobs@x.com", "Your application", "Unfortunately we have decided to move forward with other candidates."), "recusa")

    def test_entrevista(self):
        self.assertEqual(tipo_de("a@b.com", "Agendamento entrevista", ""), "entrevista")

    def test_teste(self):
        self.assertEqual(tipo_de("invitation@alvalabs.io", "Nordtel has invited you to complete an assessment", ""), "teste")

    def test_rececao(self):
        self.assertEqual(tipo_de("system@successfactors.com", "Candidatura recebida", "A tua candidatura está em análise."), "rececao")

    def test_alerta(self):
        self.assertEqual(tipo_de("donotreply@jobalert.indeed.com", "Developer em Porto. Mais 29 ofertas", ""), "alerta")


class Associar(unittest.TestCase):
    def test_nucleo(self):
        self.assertEqual(nucleo_empresa("ACME Software Lda"), ["acme software", "acme"])
        self.assertEqual(nucleo_empresa("Empresa não identificada (IEFP)"), [])

    def test_pelo_dominio(self):
        self.assertEqual(associar({"de": "Ana <ana@acme.pt>", "assunto": "Olá"}, CANDS), "acme-dev")

    def test_dominio_explicito(self):
        self.assertEqual(associar({"de": "invitation@talentplatform.io", "assunto": "Assessment"}, CANDS), "nordtel")

    def test_prefere_a_aberta(self):
        self.assertEqual(associar({"de": "Nordtel Careers <careers@nordtel.com>", "assunto": "Update"}, CANDS), "nordtel")

    def test_sem_correspondencia(self):
        self.assertIsNone(associar({"de": "news@outra.com", "assunto": "Promoção"}, CANDS))


class Sugestao(unittest.TestCase):
    def test_recusa_fecha(self):
        r = classificar({"de": "hr@acme.pt", "assunto": "Candidatura", "resumo": "Infelizmente não avançamos."}, CANDS)
        self.assertEqual(r, {"tipo": "recusa", "candidatura": "acme-dev", "sugestao": "fechada"})

    def test_rececao_nao_recua(self):
        r = classificar({"de": "hr@acme.pt", "assunto": "Candidatura recebida", "resumo": ""}, CANDS)
        self.assertIsNone(r["sugestao"])

    def test_alerta_sem_candidatura(self):
        r = classificar({"de": "jobalert@acme.pt", "assunto": "Job alert", "resumo": ""}, CANDS)
        self.assertEqual(r["tipo"], "alerta")
        self.assertIsNone(r["candidatura"])


if __name__ == "__main__":
    unittest.main()
