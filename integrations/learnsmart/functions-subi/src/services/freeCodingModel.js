const zero = value => (typeof value === 'string' && value.trim() !== '' || typeof value === 'number') && Number.isFinite(Number(value)) && Number(value) === 0;
function isFreeCodingModel(model) {
  return model?.enabled === true && typeof model.upstreamModelId === 'string' && model.upstreamModelId.endsWith(':free')
    && model.capabilities?.toolCalling === true && zero(model.pricing?.input) && zero(model.pricing?.output);
}
module.exports = { isFreeCodingModel };
