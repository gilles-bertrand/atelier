"""Génère les fichiers de la démo (docs/DEMO.md), de façon déterministe.

    uv run --with reportlab --with pillow demo/generate-fixtures.py

Produit dans demo/fixtures/ :
  ventes/ventes-{bruxelles,liege,namur}.csv   critère 2 (Excel par mois + résumé)
  rapport-annuel-2025.pdf                      critère 4 (PDF texte de 30 pages)
  facture-scannee.pdf                          critère 4 (PDF image, sans couche texte)
  ticket-de-caisse.jpg                         critère 4 (photo)
Les montants attendus sont dans docs/DEMO.md.
"""

import csv
import random
from datetime import date, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer

OUT = Path(__file__).parent / "fixtures"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
MONO = "/System/Library/Fonts/Supplemental/Courier New.ttf"

PRODUITS = {"Café en grains 1 kg": 18.50, "Thé vert 250 g": 9.90, "Chocolat noir 100 g": 3.20, "Miel 500 g": 11.40}
MAGASINS = {"bruxelles": ("Bruxelles", 1.0), "liege": ("Liège", 0.7), "namur": ("Namur", 0.5)}


def ventes() -> None:
    rng = random.Random(2026)
    (OUT / "ventes").mkdir(parents=True, exist_ok=True)
    for magasin, (nom, poids) in MAGASINS.items():
        with open(OUT / "ventes" / f"ventes-{magasin}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["date", "magasin", "produit", "quantite", "prix_unitaire", "montant"])
            jour = date(2026, 1, 1)
            while jour <= date(2026, 6, 30):
                if jour.weekday() < 6:
                    for produit, prix in PRODUITS.items():
                        q = max(0, round(rng.gauss(6, 2.5) * poids))
                        if q:
                            w.writerow([jour.isoformat(), nom, produit, q, f"{prix:.2f}", f"{q * prix:.2f}"])
                jour += timedelta(days=1)


CHAPITRES = [
    ("Mot de la direction", "le chiffre d'affaires de la coopérative atteint 4,2 millions d'euros, en hausse de 12 %"),
    ("Activité commerciale", "les trois magasins ont servi 186 000 clients, dont 41 % de membres coopérateurs"),
    ("Approvisionnement", "68 % des produits viennent de producteurs situés à moins de 150 km"),
    ("Ressources humaines", "l'équipe compte 54 personnes, soit 9 recrutements nets sur l'année"),
    ("Environnement", "les émissions logistiques baissent de 18 % grâce aux tournées mutualisées"),
    ("Investissements", "1,1 million d'euros ont été investis, dont l'ouverture du magasin de Namur en mars"),
    ("Résultats financiers", "le résultat net s'établit à 238 000 euros, contre 151 000 euros en 2024"),
    ("Gouvernance", "l'assemblée générale a réuni 612 coopérateurs et élu trois nouveaux administrateurs"),
    ("Risques", "le principal risque identifié est la hausse de 23 % du prix du café vert"),
    ("Perspectives 2026", "l'objectif est un chiffre d'affaires de 4,8 millions d'euros et un quatrième magasin à Mons"),
]
PHRASES = [
    "Au cours de l'exercice, {fait}.",
    "Ce chiffre s'explique par un travail de fond mené avec les équipes et les partenaires de la coopérative.",
    "Les indicateurs détaillés figurent dans les tableaux de suivi présentés au conseil d'administration.",
    "La comparaison avec l'exercice précédent confirme la tendance observée depuis trois ans.",
    "Plusieurs groupes de travail ont été constitués pour approfondir ces questions en 2026.",
    "Les membres ont été consultés à deux reprises, lors des réunions de quartier du printemps et de l'automne.",
    "Les procédures internes ont été revues afin de mieux suivre l'évolution de ces indicateurs.",
]


def rapport() -> None:
    rng = random.Random(30)
    styles = getSampleStyleSheet()
    doc = SimpleDocTemplate(str(OUT / "rapport-annuel-2025.pdf"), pagesize=A4, title="Rapport annuel 2025")
    story = [Paragraph("Coopérative Terre & Tasse : rapport annuel 2025", styles["Title"]), Spacer(1, 12)]
    for i, (titre, fait) in enumerate(CHAPITRES, start=1):
        if i > 1:
            story.append(PageBreak())
        story.append(Paragraph(f"{i}. {titre}", styles["Heading1"]))
        for page in range(3):
            for _ in range(5):
                phrases = [PHRASES[0].format(fait=fait)] if page == 0 else []
                phrases += rng.sample(PHRASES[1:], 4)
                story.append(Paragraph(" ".join(phrases), styles["BodyText"]))
                story.append(Spacer(1, 8))
            if page < 2:
                story.append(PageBreak())
    doc.build(story)


FACTURE = [("Ramettes papier A4 80 g", 20, 4.50), ("Cartouches toner noir", 3, 62.00), ("Reliure de rapports", 12, 7.25)]
TICKET = [("Pain au levain", 1, 4.20), ("Croissant", 4, 1.30), ("Tarte aux pommes", 1, 12.50), ("Café", 2, 2.80)]


def eur(v: float) -> str:
    return f"{v:,.2f} €".replace(",", " ").replace(".", ",")


def facture() -> None:
    img = Image.new("L", (1240, 1754), 250)
    d = ImageDraw.Draw(img)
    f, fb, ft = ImageFont.truetype(FONT, 30), ImageFont.truetype(FONT_BOLD, 34), ImageFont.truetype(FONT_BOLD, 56)
    d.text((90, 90), "Imprimerie Lambert SRL", font=ft, fill=20)
    d.text((90, 165), "Rue des Presses 14, 4000 Liège  ·  TVA BE 0456.789.123", font=f, fill=40)
    d.text((90, 280), "FACTURE n° F-2026-0142", font=fb, fill=10)
    d.text((90, 330), "Date : 12/03/2026      Client : Coopérative Terre & Tasse", font=f, fill=30)
    y = 450
    d.text((90, y), "Désignation", font=fb, fill=10)
    d.text((700, y), "Qté", font=fb, fill=10)
    d.text((820, y), "P.U. HT", font=fb, fill=10)
    d.text((1000, y), "Total HT", font=fb, fill=10)
    d.line((90, y + 50, 1150, y + 50), fill=60, width=3)
    ht = 0.0
    for nom, q, pu in FACTURE:
        y += 80
        ht += q * pu
        for x, t in ((90, nom), (700, str(q)), (820, eur(pu)), (1000, eur(q * pu))):
            d.text((x, y), t, font=f, fill=25)
    tva = round(ht * 0.21, 2)
    y += 120
    d.line((700, y - 20, 1150, y - 20), fill=60, width=2)
    for libelle, v in (("Total HT", ht), ("TVA 21 %", tva), ("Total TTC", ht + tva)):
        d.text((700, y), libelle, font=fb, fill=10)
        d.text((1000, y), eur(v), font=fb, fill=10)
        y += 60
    d.text((90, 1600), "Paiement à 30 jours  ·  IBAN BE71 0961 2345 6769", font=f, fill=50)
    # Aspect « scanné » : légère rotation, grain, flou.
    rng = random.Random(142)
    img = img.rotate(-1.2, resample=Image.BICUBIC, fillcolor=235)
    px = img.load()
    for _ in range(60000):
        x, yy = rng.randrange(img.width), rng.randrange(img.height)
        px[x, yy] = max(0, px[x, yy] - rng.randrange(40, 120))
    img = img.filter(ImageFilter.GaussianBlur(0.8))
    img.convert("RGB").save(OUT / "facture-scannee.pdf", "PDF", resolution=150)


def ticket() -> None:
    w, h = 560, 980
    paper = Image.new("RGB", (w, h), (246, 243, 236))
    d = ImageDraw.Draw(paper)
    f, fb = ImageFont.truetype(MONO, 26), ImageFont.truetype(FONT_BOLD, 34)
    d.text((70, 40), "BOULANGERIE DU PARC", font=fb, fill=(30, 30, 30))
    d.text((90, 95), "Place du Parc 3, Namur", font=f, fill=(50, 50, 50))
    d.text((120, 130), "18/03/2026  08:42", font=f, fill=(50, 50, 50))
    y, total = 220, 0.0
    for nom, q, pu in TICKET:
        d.text((40, y), f"{q} x {nom}", font=f, fill=(30, 30, 30))
        d.text((400, y), f"{q * pu:6.2f}".replace(".", ","), font=f, fill=(30, 30, 30))
        total += q * pu
        y += 50
    d.text((40, y + 20), "-" * 30, font=f, fill=(60, 60, 60))
    d.text((40, y + 70), "TOTAL EUR", font=fb, fill=(20, 20, 20))
    d.text((380, y + 70), f"{total:.2f}".replace(".", ","), font=fb, fill=(20, 20, 20))
    tva = total - total / 1.06
    d.text((40, y + 140), f"dont TVA 6 %      {tva:.2f}".replace(".", ","), font=f, fill=(50, 50, 50))
    d.text((40, y + 190), "Payé par carte", font=f, fill=(50, 50, 50))
    d.text((130, h - 90), "Merci et à bientôt", font=f, fill=(60, 60, 60))
    # « Photo » : ticket incliné sur un fond de bois, ombre, flou léger.
    bg = Image.new("RGB", (1200, 1600), (122, 92, 64))
    bd = ImageDraw.Draw(bg)
    for i in range(0, 1600, 18):
        bd.line((0, i, 1200, i + 40), fill=(112 + i % 23, 84 + i % 17, 58), width=6)
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 110)).rotate(6, expand=True)
    bg.paste(shadow, (330, 330), shadow)
    rotated = paper.convert("RGBA").rotate(6, expand=True, resample=Image.BICUBIC)
    bg.paste(rotated, (300, 290), rotated)
    bg.filter(ImageFilter.GaussianBlur(0.6)).save(OUT / "ticket-de-caisse.jpg", quality=85)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    ventes()
    rapport()
    facture()
    ticket()
    print("ok", sorted(p.relative_to(OUT).as_posix() for p in OUT.rglob("*") if p.is_file()))
