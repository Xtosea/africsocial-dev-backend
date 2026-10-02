function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: corsHeaders(),
  });
}

const stickers = [
  {
    _id: "1",
    name: "Smile",
    url: "/stickers/smile.webp",
    category: "emoji",
  },
  {
    _id: "2",
    name: "Love",
    url: "/stickers/love.webp",
    category: "love",
  },
  {
    _id: "3",
    name: "Fire",
    url: "/stickers/fire.webp",
    category: "emoji",
  },
];

export async function getStickers(request, env) {
  return json(stickers);
}
