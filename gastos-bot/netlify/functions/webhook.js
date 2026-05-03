export const handler = async (event) => {
  console.log("BODY:", event.body);
  return { statusCode: 200, body: "OK test" };
};
