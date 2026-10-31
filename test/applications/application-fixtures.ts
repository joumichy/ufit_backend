import type { BrandApplicationDossier, CreatorApplicationDossier } from "../../src/modules/applications/types/application-contract";
export const creatorDossier: CreatorApplicationDossier = {
  instagramUrl: "https://example.test/creator/instagram", dominantStyle: "Minimaliste", brandsWorn: "Marques indépendantes",
  outfitExampleUrls: ["https://example.test/outfit/one", "https://example.test/outfit/two", "https://example.test/outfit/three"],
};
export const brandDossier: BrandApplicationDossier = {
  instagramUrl: "https://example.test/brand/instagram", country: "CH", priceRange: "Prix indicatifs, gamme créateur",
  lookbookUrl: "https://example.test/brand/lookbook", shippingCapabilities: "Expédition internationale manuelle", returnPolicy: "Retours sous trente jours après livraison",
};
