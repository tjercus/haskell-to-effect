module Main where

data Shape = Circle Int | Rect Int Int
  deriving (Show, Eq)

area :: Shape -> Int
area (Circle r) = 3 * r * r
area (Rect w h) = w * h

describe :: Shape -> String
describe s = case s of
  Circle _ -> "circle of area " ++ show (area s)
  Rect w h
    | w == h -> "square of area " ++ show (area s)
    | otherwise -> "rectangle of area " ++ show (area s)

main :: IO ()
main = do
  let shapes = [Circle 1, Rect 2 2, Rect 2 3]
  mapM_ (putStrLn . describe) shapes
  print shapes
  print (Circle 1 == Circle 1, Circle 1 == Rect 1 1)
  print (sum (map area shapes))
