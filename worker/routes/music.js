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

const songs = [
  {
    _id: "1",
    title: "Afrobeats Vibes",
    artist: "AfricSocial",
    audioUrl:
      "https://your-domain.com/music/afrobeats.mp3",
  },
  {
    _id: "2",
    title: "Amapiano",
    artist: "AfricSocial",
    audioUrl:
      "https://your-domain.com/music/amapiano.mp3",
  },
  {
    _id: "3",
    title: "Hip Hop",
    artist: "AfricSocial",
    audioUrl:
      "https://your-domain.com/music/hiphop.mp3",
  },
];

export async function getMusic(request, env) {
  return json(songs);
}
