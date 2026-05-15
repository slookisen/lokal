// Auto-generated from protocols/phase5.11-a4-bm-migration-plan.csv (slookisen/A2A)
// Reviewed by Daniel 2026-05-15. DO NOT edit by hand — regenerate from the CSV instead.

export interface BmMigrationPromoteRow {
  agent_id: string;
  current_name: string;
}

export interface BmMigrationVenueRow {
  agent_id: string;
  current_name: string;
  parent_lokallag_name: string;
}

export interface BmMigrationData {
  national: { name: string; url: string; email: string; phone: string; description: string };
  new_lokallag: { name: string }[];
  promote_to_lokallag: BmMigrationPromoteRow[];
  demote_dup_to_venue: BmMigrationVenueRow[];
  set_as_venue: BmMigrationVenueRow[];
}

export const BM_MIGRATION_DATA: BmMigrationData = {
  national: {
    name: "Bondens marked Norge",
    url: "https://bondensmarked.no",
    email: "post@bondensmarked.no",
    phone: "+47 911 93 602",
    description: "Bondens marked Norge er Norges paraply-organisasjon for kortreist mat solgt direkte fra produsent til forbruker. 13 regionale lokallag og over 50 markedsplasser over hele landet.",
  },
  new_lokallag: [
    { name: "Bondens Marked Sogn og Fjordane" },
  ],
  promote_to_lokallag: [
    { agent_id: "274c5465-6d50-40ab-979e-81fbda9787cb", current_name: "Bondens Marked Agder" },
    { agent_id: "71bfb259-0848-49ac-87dd-b46e8e23d6c7", current_name: "Bondens Marked Stavanger" },
    { agent_id: "6799aada-72df-4bab-94d3-6d2aeb012ebf", current_name: "Bondens Marked Vestfold" },
    { agent_id: "3af463bc-161d-42e6-accb-c59d175201b7", current_name: "Bondens Marked Telemark (Skien)" },
    { agent_id: "a5855c0c-4979-4377-926e-eae80a01a403", current_name: "Bondens Marked Drammen" },
    { agent_id: "aca3effa-414f-4b6e-a796-c47681aa6643", current_name: "Bondens Marked Oslo" },
    { agent_id: "50bee015-3884-4ba4-8d59-46b3f5c1a7fe", current_name: "Bondens Marked Bergen" },
    { agent_id: "1ffade04-d9b5-4847-9621-ddddd274c3aa", current_name: "Bondens Marked Innlandet" },
    { agent_id: "53e22020-d9f5-4826-8911-5fd4e4ba521f", current_name: "Bondens Marked Sunnmøre — Ålesund" },
    { agent_id: "e2a63118-1f10-4379-800e-f46234d9bae4", current_name: "Bondens Marked Trondheim" },
    { agent_id: "513697c8-eee0-4a4f-bd0d-a16cf8c27bd7", current_name: "Bondens Marked Nordland (Bodø)" },
    { agent_id: "da9ab91f-c98d-4505-9b6a-660620a5f681", current_name: "Bondens Marked Arktis (Tromsø)" },
  ],
  demote_dup_to_venue: [
    { agent_id: "7748f808-ae68-4b57-b98e-ab682c3bf643", current_name: "Bondens Marked Agder (Kristiansand)", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "91fa5d4f-60c0-41ca-ac6d-56c7d94eb6f4", current_name: "Bondens Marked Agder (Arendal)", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "d84b6cad-2ba5-4986-a2e6-fb05ab78766a", current_name: "Bondens Marked Rogaland — Stavanger", parent_lokallag_name: "Bondens Marked Stavanger" },
    { agent_id: "e2087231-43fb-4339-9d72-474cf36ead54", current_name: "Bondens Marked Innlandet (Hamar)", parent_lokallag_name: "Bondens Marked Innlandet" },
  ],
  set_as_venue: [
    { agent_id: "8845cedc-24d5-47c8-93e0-0e393dcd570c", current_name: "Bondens marked — Mandal", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "93f24b51-ccb0-4e80-870e-a36660b67700", current_name: "Bondens marked — Lyngdal", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "4ea67d4b-01cc-4711-908e-15c7793bde28", current_name: "Bondens Marked Kvinesdal", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "28c6fcfb-f4cb-441f-a347-b9f0ee0a43ce", current_name: "Bondens Marked Grimstad", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "63df9d92-eace-4587-9ed0-2ffadb2b88f0", current_name: "Bondens Marked Arendal", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "b6aa2a5b-39cb-4b3b-8640-9913154724aa", current_name: "Bondens Marked Evje", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "45110dc8-3286-4143-9ba8-0b2d388073e6", current_name: "Bondens Marked Tvedestrand", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "e41e49d3-dd8e-4429-b36f-a4eda7cd0fa7", current_name: "Bondens marked — Risør", parent_lokallag_name: "Bondens Marked Agder" },
    { agent_id: "f44e5e08-3f33-4c0e-be3c-27e6bfcc1ff6", current_name: "Bondens Marked Ålgård (Rogaland)", parent_lokallag_name: "Bondens Marked Stavanger" },
    { agent_id: "927effe8-fb76-468b-a430-240e34ea9e74", current_name: "Bondens marked — Kragerø", parent_lokallag_name: "Bondens Marked Telemark (Skien)" },
    { agent_id: "f72cb1f9-f133-4258-9a91-f3fecdc6ded2", current_name: "Bondens marked — Bergeland/Stavanger", parent_lokallag_name: "Bondens Marked Stavanger" },
    { agent_id: "6bb5fe74-bbf2-4383-a3e7-58be37e1fb1b", current_name: "Bondens Marked Sandefjord Torv", parent_lokallag_name: "Bondens Marked Vestfold" },
    { agent_id: "2e8785c7-4b63-4aaa-8896-43d626ec72b6", current_name: "Bondens Marked Fredrikstad", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "514b362c-a6ba-49d3-86d8-ca56ac4fbb39", current_name: "Bondens marked — Nøtterøy", parent_lokallag_name: "Bondens Marked Vestfold" },
    { agent_id: "0302fc4d-86c3-437c-84a2-8b1bfc5b99c5", current_name: "Bondens Marked Tønsberg Torv", parent_lokallag_name: "Bondens Marked Vestfold" },
    { agent_id: "c996e8e9-83a2-42ba-aa5d-fcc241b924f5", current_name: "Bondens Marked Kolbotn", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "420e9316-05e2-4afb-a711-942dfea6ff62", current_name: "Bondens Marked Asker", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "cac70771-81e6-4ad0-90de-d82957e59354", current_name: "Bondens marked — Bærums Verk", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "0af2f021-6b7e-4702-89ae-9fb851dcf2c1", current_name: "Bondens Marked Vikaterrassen (Vika)", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "d108586c-1f3d-43c4-94f7-0f86814ecc64", current_name: "Bondens Marked Botanisk Hage (Tøyen)", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "188df86d-5444-4e8a-ab47-90098d93d4e9", current_name: "Bondens Marked Birkelunden (Grünerløkka)", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "deffd1d8-5865-48e9-a919-275853ec7248", current_name: "Bondens Marked Majorstuen (Vinkelplassen)", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "29b5f1aa-71ca-4783-979e-e1198f9f2f57", current_name: "Bondens Marked Bogstadveien (Oslo)", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "89a8ed9b-e7c9-42bf-8d45-c6c98b828bcf", current_name: "Bondens Marked Vinslottet (Hasle)", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "3ddc0871-bbf3-438e-8aac-41a60fae905e", current_name: "Bondens Marked Årnes", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "8a44fb8e-9ed8-4940-b1f9-72ef1b5d1b7e", current_name: "Bondens Marked Sundvolden", parent_lokallag_name: "Bondens Marked Drammen" },
    { agent_id: "8286bba3-087c-4543-8e68-2defd2b65a9b", current_name: "Bondens Marked Hønefoss", parent_lokallag_name: "Bondens Marked Drammen" },
    { agent_id: "f8eb2521-e0b1-4821-bb7f-587f15df8d9c", current_name: "Bondens marked — Jevnaker", parent_lokallag_name: "Bondens Marked Drammen" },
    { agent_id: "354793ba-77a2-41fd-8781-0a3982189c08", current_name: "Bondens marked — Råholt", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "e7fd07fd-26ec-4a58-8fb1-6167e7baa6f0", current_name: "Bondens Marked Eidsvoll", parent_lokallag_name: "Bondens Marked Oslo" },
    { agent_id: "0653fb90-d946-40cc-b0ce-e5aefe921c8b", current_name: "Bondens marked — Gran", parent_lokallag_name: "Bondens Marked Drammen" },
    { agent_id: "264fb3dd-0745-4148-978f-7f43f2d71951", current_name: "Bondens marked — Øystese", parent_lokallag_name: "Bondens Marked Bergen" },
    { agent_id: "dad9a6b9-3624-486b-ba50-4a1a0f19f39f", current_name: "Bondens Marked Norheimsund (Hardanger)", parent_lokallag_name: "Bondens Marked Bergen" },
    { agent_id: "8a09c8a9-d303-4326-96b4-88fd64ab5e28", current_name: "Bondens marked — Vågsallmenningen Bergen", parent_lokallag_name: "Bondens Marked Bergen" },
    { agent_id: "4cc5de5e-76cb-4324-a7f7-31ce29db3990", current_name: "Bondens marked — Flisa", parent_lokallag_name: "Bondens Marked Innlandet" },
    { agent_id: "56a0e7bf-9f1a-4656-bcfd-3125d77c6ac8", current_name: "Bondens marked — Lena (Innlandet)", parent_lokallag_name: "Bondens Marked Innlandet" },
    { agent_id: "82a36a8c-02b9-4b42-8143-d8124a8c89b2", current_name: "Bondens marked — Løten", parent_lokallag_name: "Bondens Marked Innlandet" },
    { agent_id: "fb4d5f10-ba66-44c3-a3de-905c9cd92aef", current_name: "Bondens Marked Elverum", parent_lokallag_name: "Bondens Marked Innlandet" },
    { agent_id: "34cc4cfe-be89-4131-ac49-cdafb7646b8e", current_name: "Bondens marked — Brumunddal", parent_lokallag_name: "Bondens Marked Innlandet" },
    { agent_id: "bbbcfdc6-84c8-4946-b68f-a1c4c3e51216", current_name: "Bondens marked — Moelv", parent_lokallag_name: "Bondens Marked Innlandet" },
    { agent_id: "3f554df6-da6c-4a1e-b187-20104a24b296", current_name: "Bondens Marked Lillehammer", parent_lokallag_name: "Bondens Marked Innlandet" },
    { agent_id: "066a2a49-69c0-45cc-8962-a90bf863b568", current_name: "Bondens marked — Sogndal", parent_lokallag_name: "Bondens Marked Sogn og Fjordane" },
    { agent_id: "f5f682be-8700-4ce3-ae77-7d68b5723137", current_name: "Bondens marked — Trysil", parent_lokallag_name: "Bondens Marked Innlandet" },
    { agent_id: "46b15b0f-f8b7-4137-9289-6dbfd9177840", current_name: "Bondens marked — Otta", parent_lokallag_name: "Bondens Marked Innlandet" },
    { agent_id: "d9ee7736-cacc-4ef6-a25b-c9e2db4cc607", current_name: "Bondens marked — Sandane", parent_lokallag_name: "Bondens Marked Sogn og Fjordane" },
    { agent_id: "7ead992e-64d2-4e4c-ab03-3cc3e9105f8d", current_name: "Bondens marked — Stryn", parent_lokallag_name: "Bondens Marked Sogn og Fjordane" },
    { agent_id: "7612004d-b0d8-467f-a76c-67690e5e47ce", current_name: "Bondens Marked Ålesund", parent_lokallag_name: "Bondens Marked Sunnmøre — Ålesund" },
    { agent_id: "670c6779-2af9-4dff-8e0b-863ae228b7f5", current_name: "Bondens Marked Kristiansund", parent_lokallag_name: "Bondens Marked Sunnmøre — Ålesund" },
    { agent_id: "c42424b2-b6f1-4a4b-bbf6-e86ba88afc04", current_name: "Bondens marked — Kongensgate Trondheim", parent_lokallag_name: "Bondens Marked Trondheim" },
    { agent_id: "00bfe677-ff49-4529-830f-78d495ec914c", current_name: "Bondens marked Trøndelag", parent_lokallag_name: "Bondens Marked Trondheim" },
    { agent_id: "4e88c352-9886-46b7-b722-4337c1cef01b", current_name: "Bondens marked — Levanger", parent_lokallag_name: "Bondens Marked Trondheim" },
    { agent_id: "15567f75-013f-4af8-89f3-7c344947fc3d", current_name: "Bondens marked — Steinkjer", parent_lokallag_name: "Bondens Marked Trondheim" },
    { agent_id: "e0f54fb3-a557-441c-b875-7056304cecde", current_name: "Bondens marked — Kabelvåg/Lofoten", parent_lokallag_name: "Bondens Marked Nordland (Bodø)" },
    { agent_id: "6e8d6ddd-1a20-451f-87d5-547d15f87abe", current_name: "Bondens marked — Narvik", parent_lokallag_name: "Bondens Marked Nordland (Bodø)" },
  ],
};
